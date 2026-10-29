#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadWorkspaces, singleLine, type WorkspaceEntry } from "./config.js";
import { createInterface } from "node:readline/promises";
import { connectWorkspace, disconnectWorkspace, findWorkspace, openWorkspace } from "./connect.js";
import { askWithSystemDialog } from "./dialog.js";
import { confirmInTerminal } from "./management.js";
import { createServer } from "./server.js";

class UsageError extends Error {}

// No arguments: MCP server over stdio. Otherwise: CLI.
// stdout is reserved for MCP messages, so server mode logs only to stderr.
const [command, ...args] = process.argv.slice(2);

const USAGE = `사용법:
  multi-workspace-for-notion                       MCP 서버(stdio)로 실행
  multi-workspace-for-notion list                  연결된 워크스페이스 목록
  multi-workspace-for-notion add [설명...]          워크스페이스 연결(브라우저에서 고른 워크스페이스의 이름으로 연결)
  multi-workspace-for-notion tools <이름>           저장된 인증으로 붙어서 확인하고 도구 목록 출력
  multi-workspace-for-notion remove <이름>          확인 창에서 승인하면 연결 해제와 토큰 삭제
  (이름에 공백이 있으면 따옴표로 감싼다: remove "My Notion")`;

try {
  switch (command) {
    case undefined: {
      const server = await createServer();
      await server.connect(new StdioServerTransport());
      // The SDK doesn't notice stdin ending. When the client goes away, close: that drops open confirmations, so a
      // dialog left on screen can't later disconnect a workspace for a request nobody is waiting on.
      process.stdin.once("end", () => void server.close());
      // Exiting on a signal runs the 'exit' hook that closes our dialogs (dialog.ts); the default action would not.
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => process.exit(0));
      break;
    }
    case "list": {
      const workspaces = await loadWorkspaces();
      if (workspaces.length === 0) {
        console.log("연결된 워크스페이스가 없습니다.");
      }
      for (const w of workspaces) {
        console.log(`${singleLine(w.name, 100)}\t${w.status}\t${singleLine(w.description, 200)}`);
      }
      break;
    }
    case "session-start": {
      // Claude Code SessionStart hook. systemMessage is shown only to the user; Claude already has the server instructions.
      // Reads just the config file, no network, so it stays fast.
      console.log(JSON.stringify({ systemMessage: sessionStatus(await loadWorkspaces()) }));
      break;
    }
    case "add": {
      const { entry, tools } = await connectWorkspace({
        description: args.join(" "),
        onAuthorizationUrl: (url) =>
          console.log(
            "브라우저에서 Notion 인증 화면을 엽니다. 연결할 워크스페이스를 골라 승인하세요.\n" +
              `브라우저가 열리지 않으면 이 주소로 들어가세요:\n${url.href}\n`,
          ),
      });
      console.log(`연결했습니다: "${entry.name}" (${entry.notionWorkspaceId})`);
      console.log(`공식 도구 ${tools.length}개를 받았습니다.`);
      break;
    }
    case "tools": {
      const [name] = args;
      if (!name) throw new UsageError();
      const session = await openWorkspace(name);
      try {
        const self = await session.getSelf();
        const tools = await session.listTools();
        console.log(`"${name}" → Notion "${self.workspaceName}" (${self.workspaceId}), 도구 ${tools.length}개`);
        for (const tool of tools) console.log(`  ${tool.name}`);
      } finally {
        await session.close();
      }
      break;
    }
    case "remove": {
      const [name] = args;
      if (!name) throw new UsageError();
      await findWorkspace(name);
      // A person confirms here too; otherwise a model's shell tool could use this command to skip the MCP dialog.
      const typeName = process.stdin.isTTY && process.stdout.isTTY ? askInTerminal : undefined;
      if (!(await confirmInTerminal(name, askWithSystemDialog, typeName))) {
        console.error("연결을 해제하지 않았습니다.");
        process.exitCode = 1;
        break;
      }
      const { revoked } = await disconnectWorkspace(name);
      if (revoked) console.log(`연결을 해제했습니다: ${name} (Notion 쪽 토큰도 해제)`);
      else console.log(`연결을 해제했습니다: ${name}\nNotion 쪽 토큰 해제는 실패했습니다. Notion 설정의 연결(Connections) 메뉴에서 해제하세요.`);
      break;
    }
    default:
      throw new UsageError(`알 수 없는 명령: ${command}`);
  }
} catch (error) {
  // A failing hook must not block the session from starting.
  if (command === "session-start") process.exit(0);
  if (error instanceof UsageError) {
    console.error(error.message ? `${error.message}\n\n${USAGE}` : USAGE);
  } else {
    console.error(`오류: ${(error as Error).message}`);
  }
  process.exitCode = 1;
}

function sessionStatus(workspaces: WorkspaceEntry[]): string {
  if (workspaces.length === 0) return "Notion: 연결된 워크스페이스가 없습니다. /multi-workspace:workspace-add 로 연결하세요.";
  const names = workspaces.map((w) => singleLine(w.name, 100)).join(", ");
  const broken = workspaces.filter((w) => w.status !== "connected").map((w) => w.name);
  return broken.length === 0
    ? `Notion: ${names}`
    : `Notion: ${names} · 확인 필요: ${broken.join(", ")} → /multi-workspace:workspace-check`;
}

async function askInTerminal(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
