import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { cachePath, configDir, type WorkspaceEntry } from "./config.js";
import { openWorkspaceById } from "./connect.js";
import type { NotionSession } from "./notion.js";

/**
 * One upstream session per workspace for this process, opened on first use and reused. Keyed by workspace ID, not
 * name: a name can move to another workspace when it is disconnected and reconnected in another session.
 */
export class UpstreamPool {
  private readonly sessions = new Map<string, Promise<NotionSession>>();

  constructor(private readonly open: (workspaceId: string) => Promise<NotionSession> = openWorkspaceById) {}

  session(workspaceId: string): Promise<NotionSession> {
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing;
    const opened = this.open(workspaceId);
    // Forget a failed open so the next call retries.
    opened.catch(() => {
      if (this.sessions.get(workspaceId) === opened) this.sessions.delete(workspaceId);
    });
    this.sessions.set(workspaceId, opened);
    return opened;
  }

  /**
   * An expired upstream MCP session gets a 404 and the request was not processed, so reopen and send it once more.
   * Other errors may come after the request was processed, so those are never resent.
   */
  async callTool(workspaceId: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return await (await this.session(workspaceId)).callTool(name, args);
    } catch (error) {
      if (!(error instanceof StreamableHTTPError && error.code === 404)) throw error;
      await this.reset(workspaceId);
      return (await this.session(workspaceId)).callTool(name, args);
    }
  }

  async reset(workspaceId: string): Promise<void> {
    const pending = this.sessions.get(workspaceId);
    this.sessions.delete(workspaceId);
    await pending?.then((s) => s.close()).catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.reset(id)));
  }
}

export interface WorkspaceCatalog {
  /** The workspace's name, as in WorkspaceTools.alias */
  alias: string;
  /** The Notion workspace this catalog was fetched from; upstream calls are routed by it. */
  workspaceId: string;
  tools: Tool[];
  instructions: string | undefined;
}

export interface CatalogFailure {
  alias: string;
  reason: string;
}

const LIVE_TIMEOUT_MS = 15_000;

/**
 * Fetches each connected workspace's tool list and instructions and caches them on disk.
 * When offline or timed out it falls back to the cache, and reports a failure only if there is no cache either.
 */
export async function loadCatalogs(
  workspaces: WorkspaceEntry[],
  pool: UpstreamPool,
): Promise<{ catalogs: WorkspaceCatalog[]; failures: CatalogFailure[] }> {
  const results = await Promise.all(
    workspaces.map(async (w): Promise<WorkspaceCatalog | CatalogFailure> => {
      try {
        const catalog = await withTimeout(fetchLive(w, pool), LIVE_TIMEOUT_MS);
        await writeCache(catalog, w.notionWorkspaceId);
        return catalog;
      } catch (error) {
        // The cache is keyed by ID, but the workspace's current name is what the catalog is known by.
        const cached = await readCache(w.notionWorkspaceId);
        return cached
          ? { ...cached, alias: w.name, workspaceId: w.notionWorkspaceId }
          : { alias: w.name, reason: (error as Error).message };
      }
    }),
  );
  return {
    catalogs: results.filter((r): r is WorkspaceCatalog => "tools" in r),
    failures: results.filter((r): r is CatalogFailure => "reason" in r),
  };
}

async function fetchLive(w: WorkspaceEntry, pool: UpstreamPool): Promise<WorkspaceCatalog> {
  const session = await pool.session(w.notionWorkspaceId);
  return {
    alias: w.name,
    workspaceId: w.notionWorkspaceId,
    tools: await session.listTools(),
    instructions: session.instructions,
  };
}

async function writeCache(catalog: WorkspaceCatalog, workspaceId: string): Promise<void> {
  await mkdir(join(configDir(), "cache"), { recursive: true, mode: 0o700 });
  const tmp = `${cachePath(workspaceId)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(catalog), { mode: 0o600 });
  await rename(tmp, cachePath(workspaceId));
}

async function readCache(workspaceId: string): Promise<WorkspaceCatalog | undefined> {
  try {
    const cached = JSON.parse(await readFile(cachePath(workspaceId), "utf8")) as WorkspaceCatalog;
    // A damaged cache is treated as missing rather than stopping the server at startup.
    return Array.isArray(cached?.tools) ? cached : undefined;
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${ms / 1000}초 안에 응답이 없습니다.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
