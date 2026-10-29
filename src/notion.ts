import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { singleLine } from "./config.js";
import type { WorkspaceAuthProvider } from "./oauth.js";
import { SERVER_NAME, SERVER_VERSION } from "./meta.js";

export const NOTION_MCP_URL = new URL("https://mcp.notion.com/mcp");

export interface NotionSelf {
  workspaceId: string;
  workspaceName: string;
}

/** One upstream session with the official Notion MCP server. */
export class NotionSession {
  private constructor(private readonly client: Client) {}

  static async open(provider: WorkspaceAuthProvider): Promise<NotionSession> {
    const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION });
    await client.connect(new StreamableHTTPClientTransport(NOTION_MCP_URL, { authProvider: provider }));
    return new NotionSession(client);
  }

  get instructions(): string | undefined {
    return this.client.getInstructions();
  }

  async listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  /** Asks notion-get-self which workspace this token actually belongs to. */
  async getSelf(): Promise<NotionSelf> {
    const result = await this.client.callTool({ name: "notion-get-self", arguments: {} });
    const text = (result.content as { type: string; text?: string }[])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    if (result.isError) throw new Error(`notion-get-self 실패: ${text}`);
    return parseSelf(text);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** notion-get-self returns {"workspace":{"id","name"},"user":{...}}. */
function parseSelf(text: string): NotionSelf {
  const workspace = (JSON.parse(text) as { workspace?: { id?: unknown; name?: unknown } }).workspace;
  if (typeof workspace?.id !== "string" || typeof workspace.name !== "string") {
    throw new Error(`notion-get-self 응답에서 워크스페이스를 찾지 못했습니다: ${text.slice(0, 300)}`);
  }
  // The name is set by the workspace's admin and becomes the routing key, so keep it to one short line; never empty.
  return { workspaceId: workspace.id, workspaceName: singleLine(workspace.name, 100) || workspace.id };
}
