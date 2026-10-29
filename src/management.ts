import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadWorkspaces, updateWorkspaces, type WorkspaceStatus } from "./config.js";
import { connectWorkspace, disconnectWorkspace, findWorkspace, openWorkspace } from "./connect.js";
import { errorResult } from "./proxy.js";

const workspaceParam = { type: "string", description: "워크스페이스 이름(workspace_list의 name)" } as const;

export const managementTools: Tool[] = [
  {
    name: "workspace_list",
    description: "연결된 Notion 워크스페이스의 이름, ID, 설명, 상태, 연결을 마지막으로 확인한 시각을 보여준다.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "워크스페이스 목록", readOnlyHint: true },
  },
  {
    name: "workspace_connect",
    description:
      "새 Notion 워크스페이스를 연결한다. 첫 호출은 사용자의 브라우저에 Notion 로그인 화면을 열고 그 로그인 주소(authorizationUrl)를 바로 돌려준다. " +
      "브라우저가 안 열렸을 수 있으니 주소를 사용자에게 보여주고, 연결할 워크스페이스를 골라 승인하라고 한다(최대 10분). " +
      "사용자가 승인했다고 하면 다시 호출해 결과를 받는다. 연결된 워크스페이스는 Notion에서의 이름으로 불리고, 이 대화에서 바로 workspace 값으로 쓸 수 있다.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "워크스페이스에 무엇이 있는지 짧은 설명. Claude가 워크스페이스를 고를 때 쓴다." },
      },
    },
    annotations: { title: "워크스페이스 연결", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "workspace_disconnect",
    description:
      "워크스페이스 연결을 해제한다. 이 컴퓨터에 저장된 토큰과 설정을 지우고 Notion 쪽 토큰도 해제한다. " +
      "되돌릴 수 없으므로 사용자가 직접 요청했을 때만 호출한다. 서버가 실행 전에 사용자에게 확인 창을 띄운다.",
    inputSchema: { type: "object", properties: { workspace: workspaceParam }, required: ["workspace"] },
    annotations: { title: "워크스페이스 연결 해제", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "workspace_check",
    description:
      "저장된 인증으로 워크스페이스에 다시 붙어서 연결이 살아 있는지, 처음 연결한 그 워크스페이스가 맞는지 확인하고 도구 수를 알려준다. 결과로 상태를 갱신한다.",
    inputSchema: { type: "object", properties: { workspace: workspaceParam }, required: ["workspace"] },
    annotations: { title: "워크스페이스 연결 확인", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

export type ConfirmAnswer = "accepted" | "declined" | "cancelled" | "not_shown" | "no_answer" | "unsupported";

export const NOT_CONFIRMED: Record<Exclude<ConfirmAnswer, "accepted">, string> = {
  declined: "사용자가 확인 창에서 취소했습니다.",
  cancelled: "요청이 취소됐거나 클라이언트 연결이 끊겼습니다.",
  not_shown: "확인 창이 뜨지 않았습니다.",
  no_answer: "확인 창에 응답이 없었습니다(10분). 다시 시도하면 확인 창이 다시 뜹니다.",
  unsupported: "확인 창을 띄울 수 없었습니다. 화면이 있는 로그인 세션에서 실행 중인지 확인하세요.",
};

export const disconnectQuestion = (name: string) =>
  `"${name}" 워크스페이스의 연결을 해제할까요? 이 컴퓨터의 토큰과 설정을 지우고 Notion 쪽 토큰도 해제합니다. 되돌릴 수 없습니다.`;

/**
 * Asks the user, never the model: in the client's own dialog when it has one, otherwise (or when the client cancels
 * without showing it) in a native system dialog. A user who said no in the client's dialog is not asked again, and
 * nothing is asked once the request was cancelled or the client went away: no one is there to see it.
 */
export async function confirmWithUser(
  message: string,
  askInClient: ((message: string) => Promise<ConfirmAnswer>) | undefined,
  askWithSystemDialog: (message: string) => Promise<ConfirmAnswer>,
  signal?: AbortSignal,
): Promise<ConfirmAnswer> {
  const answer = askInClient ? await askInClient(message) : "unsupported";
  if (signal?.aborted) return "cancelled";
  const final = answer === "not_shown" || answer === "unsupported" ? await askWithSystemDialog(message) : answer;
  // A yes that arrives after the request was dropped belongs to no one.
  return signal?.aborted ? "cancelled" : final;
}

/**
 * How a failed elicitation request is read. Only a client that really can't show the form (it lacks form support
 * or doesn't implement the method) earns the system dialog; a closed connection, a cancelled call or any other error
 * means the person who asked has gone, so nothing more is asked.
 */
export function elicitationFailure(error: unknown, aborted: boolean): ConfirmAnswer {
  if (aborted) return "cancelled";
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === -32001) return "no_answer"; // RequestTimeout: our own 10-minute wait ran out
  if (code === -32601 || /does not support/i.test(String(message ?? ""))) return "not_shown";
  return "cancelled";
}

/**
 * For the CLI `remove`: the same person-only confirmation as the MCP tool, so a shell tool can't use the CLI to skip
 * it. The system dialog first; where none can be shown (SSH), typing the exact name in a real terminal. `typeName` is
 * undefined unless stdin and stdout are both a TTY, so piped input never counts as a yes.
 */
export async function confirmInTerminal(
  name: string,
  askWithSystemDialog: (message: string) => Promise<ConfirmAnswer>,
  typeName: ((prompt: string) => Promise<string>) | undefined,
): Promise<boolean> {
  const answer = await askWithSystemDialog(disconnectQuestion(name));
  if (answer !== "unsupported") return answer === "accepted";
  if (!typeName) return false;
  return (await typeName(`${disconnectQuestion(name)}\n해제하려면 워크스페이스 이름을 그대로 입력하세요: `)).trim() === name;
}

/** The sign-in started by workspace_connect in this process, until its result is picked up. */
let pendingConnect: { description: string; url?: string; outcome?: CallToolResult } | undefined;

/**
 * Starts a connection and returns as soon as the sign-in URL exists, so the user can open it even when the browser
 * didn't. The sign-in finishes in the background; the next call returns its outcome.
 * shortcut: one sign-in at a time per process, since nothing identifies a connection before sign-in; that's enough for one person.
 */
export async function connectInBackground(
  description: string,
  onChanged: (staleName?: string) => Promise<void>,
  connect: typeof connectWorkspace = connectWorkspace,
): Promise<CallToolResult> {
  if (pendingConnect?.outcome) {
    const { outcome } = pendingConnect;
    pendingConnect = undefined;
    // The result may be from a sign-in Claude never came back for, so say so instead of passing it off as a new one.
    return {
      ...outcome,
      content: [
        ...outcome.content,
        { type: "text", text: "이 결과는 앞서 시작한 연결의 결과다. 다른 워크스페이스를 새로 연결하려던 것이면 workspace_connect를 한 번 더 호출한다." },
      ],
    };
  }
  if (pendingConnect) {
    // Approving that sign-in would save its description, not this one, so don't hand it out for a different request.
    if (description && description !== pendingConnect.description) {
      return errorResult(
        `다른 연결이 이미 로그인을 기다리고 있습니다(설명: "${pendingConnect.description}"). ` +
          "그 로그인을 끝내거나 10분 뒤 다시 시도하세요.",
      );
    }
    return json({ status: "waiting_for_approval", authorizationUrl: pendingConnect.url, note: "아직 승인을 기다리는 중입니다." });
  }

  const state: { description: string; url?: string; outcome?: CallToolResult } = { description };
  pendingConnect = state;
  let urlReady: () => void = () => {};
  const gotUrl = new Promise<void>((resolve) => (urlReady = resolve));
  const done = connect({
    description,
    onAuthorizationUrl: (url) => {
      state.url = url.href;
      urlReady();
    },
  }).then(
    async ({ entry, tools }) => {
      await onChanged().catch(() => {});
      state.outcome = json({ status: "connected", connected: entry, toolCount: tools.length });
    },
    (error: Error) => {
      state.outcome = errorResult(error.message);
    },
  );

  await Promise.race([gotUrl, done]);
  if (state.outcome) {
    // Finished (or failed) before any sign-in URL existed.
    pendingConnect = undefined;
    return state.outcome;
  }
  return json({
    status: "waiting_for_approval",
    authorizationUrl: state.url,
    note: "브라우저에서 이 주소로 Notion에 로그인해 워크스페이스를 골라 승인한 뒤, workspace_connect를 다시 호출하세요.",
  });
}

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));

/** Runs a management tool, or returns undefined if `name` isn't one. */
export async function callManagementTool(
  name: string,
  args: Record<string, unknown>,
  /** Rebuilds the tool list after the set of workspaces changed; closes sessions for a workspace that is gone. */
  onChanged: (staleName?: string) => Promise<void>,
  /** Asks the user directly (not the model); only "accepted" is a yes. */
  confirm: (message: string) => Promise<ConfirmAnswer>,
): Promise<CallToolResult | undefined> {
  const workspace = typeof args.workspace === "string" ? args.workspace : "";
  try {
    switch (name) {
      case "workspace_list":
        return json(await loadWorkspaces());

      case "workspace_connect":
        return await connectInBackground(typeof args.description === "string" ? args.description : "", onChanged);

      case "workspace_disconnect": {
        if (!workspace) return errorResult("workspace가 필요합니다.");
        await findWorkspace(workspace);
        // Text in a Notion page can ask the model to call this, so the user confirms it outside the model.
        const answer = await confirm(disconnectQuestion(workspace));
        // No command to run in these messages: a model with a shell tool would use it to skip the confirmation.
        if (answer !== "accepted") return errorResult(`연결을 해제하지 않았습니다. ${NOT_CONFIRMED[answer]}`);
        const { revoked } = await disconnectWorkspace(workspace);
        await onChanged(workspace);
        return json({
          disconnected: workspace,
          revokedOnNotion: revoked,
          note: revoked
            ? "이 컴퓨터의 토큰과 설정을 지우고, Notion 쪽 토큰도 해제했습니다."
            : "이 컴퓨터의 토큰과 설정을 지웠습니다. Notion 쪽 토큰 해제는 실패했으니, Notion 설정의 연결(Connections) 메뉴에서 해제하세요.",
        });
      }

      case "workspace_check":
        if (!workspace) return errorResult("workspace가 필요합니다.");
        return await checkWorkspace(workspace);

      default:
        return undefined;
    }
  } catch (error) {
    return errorResult((error as Error).message);
  }
}

export async function checkWorkspace(name: string, open: typeof openWorkspace = openWorkspace): Promise<CallToolResult> {
  const entry = await findWorkspace(name);

  let status: WorkspaceStatus;
  let detail: Record<string, unknown>;
  try {
    const session = await open(name);
    try {
      const self = await session.getSelf();
      const tools = await session.listTools();
      const sameWorkspace = self.workspaceId === entry.notionWorkspaceId;
      status = sameWorkspace ? "connected" : "error";
      detail = sameWorkspace
        ? { notionName: self.workspaceName, toolCount: tools.length }
        : { problem: `저장된 인증이 다른 워크스페이스("${self.workspaceName}")에 붙어 있습니다. 연결을 해제하고 다시 연결하세요.` };
    } finally {
      await session.close();
    }
  } catch (error) {
    const message = (error as Error).message;
    // Only a dead sign-in needs reauth; network errors (even ones mentioning OAuth) are just "error".
    const signInDead = error instanceof InvalidGrantError || error instanceof UnauthorizedError || /저장된 인증/.test(message);
    status = signInDead ? "needs_reauth" : "error";
    detail = { problem: message };
  }

  // Another process may have changed the config during the check, so update only this entry in the latest copy.
  await updateWorkspaces((workspaces) =>
    workspaces.map((w) =>
      w.notionWorkspaceId === entry.notionWorkspaceId
        ? { ...w, status, lastSuccessAt: status === "connected" ? new Date().toISOString() : w.lastSuccessAt }
        : w,
    ),
  );
  const result = json({ workspace: name, status, ...detail });
  return status === "connected" ? result : { ...result, isError: true };
}
