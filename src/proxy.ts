import { randomBytes } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const WORKSPACE_PARAM = "workspace";

/**
 * Starts every label this server adds to tool results. Labels share the text stream with Notion page content, so a
 * page could imitate them; the mark is random per process and only told to Claude in the server instructions, so a
 * page author can't know it.
 */
export const SERVER_MARK = `[mwn-${randomBytes(4).toString("hex")}]`;

/** The official tools one workspace offers. */
export interface WorkspaceTools {
  /** The workspace's name (WorkspaceEntry.name): what Claude passes as `workspace`. Called alias throughout the routing code. */
  alias: string;
  tools: Tool[];
}

export interface MergedCatalog {
  /** Tools to expose, with the workspace parameter added */
  tools: Tool[];
  /** Tool name → aliases of the workspaces that have it */
  availability: Map<string, string[]>;
}

export type UpstreamCall = (alias: string, name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * Merges the workspaces' official tools into one union.
 * Plans differ between workspaces, and so can their tools: each tool records which workspaces have it and
 * names them in its workspace parameter.
 * When a tool's definition differs between workspaces, the first workspace's definition wins.
 * (As of 2026-10 the only observed difference was notion-update-page's description; parameters matched.)
 */
export function mergeCatalogs(catalogs: WorkspaceTools[], warn: (message: string) => void = () => {}): MergedCatalog {
  const allAliases = catalogs.map((c) => c.alias);
  const firstDefinition = new Map<string, Tool>();
  const availability = new Map<string, string[]>();

  for (const { alias, tools } of catalogs) {
    for (const tool of tools) {
      const known = firstDefinition.get(tool.name);
      if (!known) {
        firstDefinition.set(tool.name, tool);
        availability.set(tool.name, [alias]);
        continue;
      }
      availability.get(tool.name)!.push(alias);
      if (JSON.stringify(known.inputSchema) !== JSON.stringify(tool.inputSchema)) {
        warn(`도구 "${tool.name}"의 입력 형식이 워크스페이스마다 다릅니다. 처음 받은 정의를 씁니다.`);
      }
    }
  }

  const merged: Tool[] = [];
  for (const [name, tool] of firstDefinition) {
    if (tool.inputSchema.properties && WORKSPACE_PARAM in tool.inputSchema.properties) {
      warn(`도구 "${name}"에 이미 "${WORKSPACE_PARAM}" 파라미터가 있어 노출하지 않습니다.`);
      availability.delete(name);
      continue;
    }
    merged.push(withWorkspaceParam(tool, availability.get(name)!, allAliases));
  }
  return { tools: merged, availability };
}

function withWorkspaceParam(tool: Tool, aliases: string[], allAliases: string[]): Tool {
  const partial = aliases.length < allAliases.length;
  return {
    ...tool,
    description: partial
      ? `[이 도구는 ${aliases.join(", ")} 워크스페이스에서만 쓸 수 있다]\n\n${tool.description ?? ""}`
      : tool.description,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        // A plain string, not an enum: Claude keeps a conversation's tool schemas even after tools/list_changed,
        // so an enum would go stale as soon as a workspace is connected. The server checks the name.
        [WORKSPACE_PARAM]: {
          type: "string",
          description: `이 호출을 보낼 Notion 워크스페이스의 이름. 이 서버를 시작할 때 연결돼 있던 워크스페이스: ${aliases.join(", ")}. 이후 새로 연결한 워크스페이스도 바로 쓸 수 있다.`,
        },
        ...tool.inputSchema.properties,
      },
      required: [WORKSPACE_PARAM, ...(tool.inputSchema.required ?? [])],
    },
  };
}

/**
 * Proxies a tool call: strips `workspace` and forwards the other arguments to that workspace unchanged.
 * The result (content, structuredContent, isError) comes back untouched.
 */
export async function callProxiedTool(
  catalog: MergedCatalog,
  name: string,
  args: Record<string, unknown> | undefined,
  call: UpstreamCall,
): Promise<CallToolResult> {
  const available = catalog.availability.get(name);
  if (!available) return errorResult(`알 수 없는 도구입니다: ${name}`);

  const { [WORKSPACE_PARAM]: workspace, ...rest } = args ?? {};
  if (typeof workspace !== "string" || workspace === "") {
    return errorResult(`${WORKSPACE_PARAM} 파라미터가 필요합니다. 쓸 수 있는 워크스페이스: ${available.join(", ")}`);
  }
  if (!available.includes(workspace)) {
    const connected = [...new Set([...catalog.availability.values()].flat())];
    return errorResult(
      connected.includes(workspace)
        ? `"${name}"은(는) ${workspace} 워크스페이스에서 쓸 수 없습니다(요금제 차이일 수 있습니다). 쓸 수 있는 워크스페이스: ${available.join(", ")}`
        : `연결되지 않은 워크스페이스입니다: ${workspace}. 연결된 워크스페이스: ${connected.join(", ")}`,
    );
  }

  let result: CallToolResult;
  try {
    result = await call(workspace, name, rest);
  } catch (error) {
    return errorResult(`${workspace} 워크스페이스 호출 실패: ${(error as Error).message}`);
  }
  const others = available.filter((alias) => alias !== workspace);
  if (!isNotFound(result) || others.length === 0) return result;

  // Notion answers object_not_found both for missing pages and for pages in another workspace.
  // Fan the lookup out to the other workspaces only for tools on this local allowlist, never based on the
  // upstream readOnlyHint: a compromised upstream (or a tampered cache) could mark a write tool read-only
  // and have one not-found call repeat the write across every workspace.
  if (!FAN_OUT_ON_NOT_FOUND.has(name)) {
    return withNote(
      result,
      `[${workspace} 워크스페이스에서 찾지 못했다. 다른 워크스페이스(${others.join(", ")})의 ID일 수 있다. ` +
        "notion-fetch로 그 ID가 있는 워크스페이스를 확인한 뒤, 사용자에게 확인을 받고 그 workspace로 다시 호출한다.]",
    );
  }
  const retries = await Promise.all(others.map((alias) => call(alias, name, rest).catch(() => undefined)));
  const found = retries.findIndex((r) => r !== undefined && !r.isError);
  if (found === -1) return result;
  return withNote(
    retries[found]!,
    `[${workspace} 워크스페이스에는 없어서 ${others[found]} 워크스페이스에서 찾은 결과다. 이 대상을 다루는 다음 호출은 workspace=${others[found]}로 보낸다.]`,
  );
}

// Read-only, look-up-by-id tools whose object_not_found is safe to retry on the user's other workspaces.
// shortcut: notion-fetch is the only one that matters in practice; add more read-only lookup tools here if needed.
const FAN_OUT_ON_NOT_FOUND = new Set(["notion-fetch"]);

const isNotFound = (result: CallToolResult) =>
  result.isError === true && result.content.some((c) => c.type === "text" && c.text.includes("object_not_found"));

const withNote = (result: CallToolResult, note: string): CallToolResult => ({
  ...result,
  content: [{ type: "text", text: `${SERVER_MARK} ${note}` }, ...result.content],
});

export const SEARCH_ALL = "search_all_workspaces";
const SEARCH_TOOL = "notion-search";

/** Exists only when two or more workspaces have notion-search. Same input as notion-search, minus workspace. */
export function searchAllTool(catalog: MergedCatalog): Tool | undefined {
  const aliases = catalog.availability.get(SEARCH_TOOL);
  const search = catalog.tools.find((t) => t.name === SEARCH_TOOL);
  if (!search || !aliases || aliases.length < 2) return undefined;
  const { [WORKSPACE_PARAM]: _, ...properties } = search.inputSchema.properties ?? {};
  return {
    name: SEARCH_ALL,
    description:
      `notion-search를 ${aliases.join(", ")} 워크스페이스에서 동시에 실행하고 결과를 워크스페이스별로 묶어 돌려준다. ` +
      "결과에 나온 페이지를 다른 도구로 다룰 때는 그 결과가 나온 워크스페이스를 workspace 값으로 쓴다. " +
      "입력은 notion-search와 같다.",
    inputSchema: {
      ...search.inputSchema,
      properties,
      required: (search.inputSchema.required ?? []).filter((r) => r !== WORKSPACE_PARAM),
    },
    // Set here, not copied from upstream: a host may auto-approve on these hints, and this tool is composed locally.
    annotations: { title: "모든 워크스페이스 검색", readOnlyHint: true, openWorldHint: true },
  };
}

/** Each workspace's results follow a "<mark> ## workspace: <alias>" header. An error only when every workspace failed. */
export async function callSearchAll(
  catalog: MergedCatalog,
  args: Record<string, unknown> | undefined,
  call: UpstreamCall,
): Promise<CallToolResult> {
  const { [WORKSPACE_PARAM]: _, ...rest } = args ?? {};
  const aliases = catalog.availability.get(SEARCH_TOOL) ?? [];
  const results = await Promise.all(
    aliases.map(async (alias) => {
      try {
        return { alias, result: await call(alias, SEARCH_TOOL, rest) };
      } catch (error) {
        return { alias, result: errorResult(`호출 실패: ${(error as Error).message}`) };
      }
    }),
  );
  return {
    content: results.flatMap(({ alias, result }) => [
      { type: "text" as const, text: `\n${SERVER_MARK} ## workspace: ${alias}${result.isError ? " (실패)" : ""}` },
      ...result.content,
    ]),
    isError: results.every((r) => r.result.isError === true),
  };
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
