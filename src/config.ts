import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { keychain } from "./keychain.js";
import { withFileLock } from "./lock.js";

export type WorkspaceStatus = "connected" | "needs_reauth" | "error";

/** Non-secret workspace info. Tokens live only in the keychain. */
export interface WorkspaceEntry {
  /**
   * What Claude passes as `workspace`: the Notion workspace's own name, as reported by notion-get-self when it was
   * connected, with the start of its ID appended if another connected workspace already had that name.
   */
  name: string;
  notionWorkspaceId: string;
  description: string;
  status: WorkspaceStatus;
  lastSuccessAt: string | null;
}

interface ConfigFile {
  version: 2;
  workspaces: WorkspaceEntry[];
}

/** 0.1.x: workspaces were keyed by a user-chosen alias. */
interface ConfigFileV1 {
  version: 1;
  workspaces: (Omit<WorkspaceEntry, "name"> & { alias: string; notionWorkspaceName: string })[];
}

/** Defaults to ~/.config/multi-workspace-for-notion; override with MWN_CONFIG_DIR. */
export function configDir(): string {
  return process.env.MWN_CONFIG_DIR ?? join(homedir(), ".config", "multi-workspace-for-notion");
}

// Notion workspace IDs are UUIDs. Checked before an ID goes into a keychain account or a file name.
export const WORKSPACE_ID = /^[0-9a-f-]{32,36}$/i;

// Keyed by workspace ID: names can hold spaces, slashes or Korean, which don't belong in keychain accounts or file names.
export const credentialAccount = (workspaceId: string) => `workspace:${workspaceId}`;
export function cachePath(workspaceId: string): string {
  // config.json is not schema-checked, so a hand-edited ID must not steer writes or deletes outside cache/.
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error(`올바르지 않은 워크스페이스 ID입니다: ${workspaceId}`);
  return join(configDir(), "cache", `catalog-${workspaceId}.json`);
}

const configPath = () => join(configDir(), "config.json");
const V1_ALIAS = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Text from Notion (workspace names) or from the model (descriptions) as one plain line: control, line-separator and
 * bidi characters become spaces, so it can't fake a new line or section where it is shown to Claude or the terminal.
 */
export function singleLine(text: string, maxLength: number): string {
  return text
    .replace(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** A name not used by the other workspaces: the plain name, the name plus the start of the ID, or the full ID. */
export function uniqueName(name: string, workspaceId: string, others: WorkspaceEntry[]): string {
  const taken = new Set(others.map((w) => w.name));
  const candidates = [name, `${name} (${workspaceId.slice(0, 8)})`, `${name} (${workspaceId})`];
  // Another workspace's admin can pick any name, including one of these, so keep going until one is free.
  for (let n = 2; ; n++) {
    const free = candidates.find((c) => !taken.has(c));
    if (free) return free;
    candidates.push(`${name} (${workspaceId}) ${n}`);
  }
}

export async function loadWorkspaces(): Promise<WorkspaceEntry[]> {
  const file = await readConfig();
  if (!file) return [];
  if (file.version === 2) return file.workspaces;
  return withFileLock("config", migrateIfNeeded);
}

/** Writes a temp file and renames it, so no process ever reads a half-written file. */
async function saveWorkspaces(workspaces: WorkspaceEntry[]): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  const data: ConfigFile = { version: 2, workspaces };
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, configPath());
}

/**
 * Read-modify-write of the config under a lock shared by all server processes, so one session's write can't
 * put back an entry another session just removed.
 */
export async function updateWorkspaces(
  change: (workspaces: WorkspaceEntry[]) => WorkspaceEntry[] | Promise<WorkspaceEntry[]>,
): Promise<void> {
  await withFileLock("config", async () => saveWorkspaces(await change(await migrateIfNeeded())));
}

async function readConfig(): Promise<ConfigFile | ConfigFileV1 | undefined> {
  await assertPrivateConfigDir();
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as ConfigFile | ConfigFileV1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Turns a 0.1.x config into the current one: each workspace is named after its Notion workspace, and its keychain
 * entry moves from the alias to the workspace ID, so nobody has to sign in again. Call with the config lock held.
 */
async function migrateIfNeeded(): Promise<WorkspaceEntry[]> {
  const file = await readConfig();
  if (!file) return [];
  if (file.version === 2) return file.workspaces;

  const migrated: WorkspaceEntry[] = [];
  for (const { alias, notionWorkspaceName, ...rest } of file.workspaces) {
    // 0.1.x only accepted this alias pattern. Anything else was hand-edited: its credentials (if any) can't be moved
    // and its name must not become a keychain account or an rm path, so that workspace has to be connected again.
    if (V1_ALIAS.test(alias)) {
      const from = `workspace:${alias}`;
      const to = credentialAccount(rest.notionWorkspaceId);
      // The token lock keeps a session that is refreshing under the old account from losing its save.
      await withFileLock(from, async () => {
        const credentials = await keychain.get(from);
        if (credentials !== undefined) {
          await keychain.set(to, credentials);
          await keychain.delete(from);
        }
      });
      await rm(join(configDir(), "cache", `catalog-${alias}.json`), { force: true });
    }
    const name = singleLine(notionWorkspaceName, 100) || rest.notionWorkspaceId;
    migrated.push({ ...rest, name: uniqueName(name, rest.notionWorkspaceId, migrated) });
  }
  await saveWorkspaces(migrated);
  return migrated;
}

/**
 * mkdir's 0700 applies only when it creates the directory, so check one that already exists: if another user can
 * write to it, they can plant files or symlinks where this server writes.
 */
async function assertPrivateConfigDir(): Promise<void> {
  // Windows has no uid or mode bits (NTFS ACLs instead); the default location under the user profile is private.
  if (process.platform === "win32") return;
  const info = await stat(configDir()).catch(() => undefined);
  if (!info) return;
  if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
    throw new Error(`설정 폴더를 다른 사용자가 쓸 수 있습니다: ${configDir()}. 본인만 쓸 수 있게 하세요 (chmod 700).`);
  }
}
