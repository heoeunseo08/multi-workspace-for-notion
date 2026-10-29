import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { startCallbackServer } from "./callback-server.js";
import {
  cachePath,
  credentialAccount,
  loadWorkspaces,
  singleLine,
  uniqueName,
  updateWorkspaces,
  WORKSPACE_ID,
  type WorkspaceEntry,
} from "./config.js";
import { keychain } from "./keychain.js";
import { NOTION_MCP_URL, NotionSession } from "./notion.js";
import { revokeTokens, type StoredCredentials, WorkspaceAuthProvider } from "./oauth.js";
import { withFileLock } from "./lock.js";
import { windowsTool } from "./platform.js";

// Generous time to pick a workspace and approve in the browser.
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
// The description is shown to Claude in every session's instructions, so it stays one short line.
const DESCRIPTION_MAX = 200;

export interface ConnectResult {
  entry: WorkspaceEntry;
  tools: Tool[];
}

/**
 * Connects one workspace, named after the Notion workspace the user picks:
 * 1. Start a loopback callback server; the SDK's auth() registers the client (DCR) and builds the PKCE authorization URL.
 * 2. Once the user picks a workspace and approves in the browser, exchange the callback's code for tokens.
 * 3. Check the actual workspace with notion-get-self and fetch the tool list.
 * 4. Under the config lock: refuse a workspace that is already connected, move the tokens to its keychain account
 *    and save the entry. On any failure the new grant is deleted here and revoked on Notion.
 */
export async function connectWorkspace(options: {
  description: string;
  onAuthorizationUrl: (url: URL) => void;
}): Promise<ConnectResult> {
  const callback = await startCallbackServer();
  const provider = WorkspaceAuthProvider.forNewConnection(callback.redirectUrl, (url) => {
    // The URL comes from discovered metadata; `open` would also launch file: or app-scheme URLs.
    if (url.protocol !== "https:") throw new Error(`https가 아닌 인증 주소는 열지 않습니다: ${url.protocol}`);
    options.onAuthorizationUrl(url);
    openBrowser(url);
  });

  let session: NotionSession | undefined;
  try {
    if ((await auth(provider, { serverUrl: NOTION_MCP_URL })) === "REDIRECT") {
      const code = await callback.waitForCode(provider.pendingState!, AUTH_TIMEOUT_MS);
      await auth(provider, { serverUrl: NOTION_MCP_URL, authorizationCode: code });
    }

    session = await NotionSession.open(provider);
    const self = await session.getSelf();
    if (!WORKSPACE_ID.test(self.workspaceId)) throw new Error(`예상하지 못한 워크스페이스 ID입니다: ${self.workspaceId}`);
    const tools = await session.listTools();

    let entry!: WorkspaceEntry;
    // Checked and moved under the lock: another process may be connecting the same workspace, and moving first
    // would overwrite that connection's credentials.
    await updateWorkspaces(async (latest) => {
      const duplicate = latest.find((w) => w.notionWorkspaceId === self.workspaceId);
      if (duplicate) {
        throw new Error(
          `"${duplicate.name}" 워크스페이스는 이미 연결되어 있습니다. Notion 인증 화면에서 다른 워크스페이스를 골랐는지 확인하세요.`,
        );
      }
      await provider.moveTo(credentialAccount(self.workspaceId));
      entry = {
        name: uniqueName(self.workspaceName, self.workspaceId, latest),
        notionWorkspaceId: self.workspaceId,
        description: singleLine(options.description, DESCRIPTION_MAX),
        status: "connected",
        lastSuccessAt: new Date().toISOString(),
      };
      return [...latest, entry];
    });
    return { entry, tools };
  } catch (error) {
    await provider.discard().catch(() => {});
    throw error;
  } finally {
    callback.close();
    await session?.close();
  }
}

/** The connected workspace with this name. */
export async function findWorkspace(name: string): Promise<WorkspaceEntry> {
  const entry = (await loadWorkspaces()).find((w) => w.name === name);
  if (!entry) throw new Error(`연결된 워크스페이스가 아닙니다: ${name}`);
  return entry;
}

/** Opens a session with a connected workspace's stored tokens. The SDK refreshes expired ones. */
export async function openWorkspace(name: string): Promise<NotionSession> {
  return openWorkspaceById((await findWorkspace(name)).notionWorkspaceId);
}

/**
 * Like openWorkspace, but by ID, so a name that now belongs to a different workspace (disconnected and reconnected in
 * another session) can't be opened under a tool list built for the old one. Fails if the ID is no longer connected.
 */
export async function openWorkspaceById(workspaceId: string): Promise<NotionSession> {
  const entry = (await loadWorkspaces()).find((w) => w.notionWorkspaceId === workspaceId);
  if (!entry) throw new Error("이 워크스페이스는 연결이 해제되었습니다. 새 대화에서 다시 시도하세요.");
  const provider = await WorkspaceAuthProvider.forExisting(workspaceId);
  if (!provider) throw new Error(`"${entry.name}"의 저장된 인증이 없습니다. 다시 연결하세요.`);
  return NotionSession.open(provider);
}

/**
 * Deletes this machine's credentials and config, then revokes the tokens on Notion.
 * Revoking needs the network and can fail, so local deletion comes first.
 */
export async function disconnectWorkspace(name: string): Promise<{ revoked: boolean }> {
  const { notionWorkspaceId: id } = await findWorkspace(name);
  // Hold the lock so a token another process is saving can't reappear after the delete.
  const raw = await withFileLock(credentialAccount(id), async () => {
    const found = await keychain.get(credentialAccount(id));
    await keychain.delete(credentialAccount(id));
    return found;
  });
  // So reconnecting this workspace never starts from the old tool list.
  await rm(cachePath(id), { force: true });
  await updateWorkspaces((workspaces) => workspaces.filter((w) => w.notionWorkspaceId !== id));
  return { revoked: raw !== undefined && (await revokeTokens(JSON.parse(raw) as StoredCredentials)) };
}

function openBrowser(url: URL): void {
  // No shell anywhere: cmd's `start` would split the URL at '&'. rundll32's handler takes it as one argument.
  const [command, ...args] =
    process.platform === "darwin"
      ? ["/usr/bin/open", url.href]
      : process.platform === "win32"
        ? [windowsTool("rundll32.exe"), "url.dll,FileProtocolHandler", url.href]
        : ["xdg-open", url.href];
  const child = spawn(command!, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => {}); // the URL printed to the terminal still works
  child.unref();
}
