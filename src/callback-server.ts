import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CallbackServer {
  redirectUrl: string;
  /** Resolves with the authorization code from Notion's callback; rejects on a state mismatch or an error response. */
  waitForCode(expectedState: string, timeoutMs: number): Promise<string>;
  close(): void;
}

type CallbackResult = { code: string; state: string | null } | { error: string };

/**
 * Temporary OAuth callback server on an OS-assigned port, loopback only.
 * The redirect URI uses `localhost` (as Claude Code does with Notion), so it listens on both 127.0.0.1 and ::1
 * with the same port, whichever way the browser resolves localhost.
 * Accepts only the first callback; call close() when done.
 */
export async function startCallbackServer(): Promise<CallbackServer> {
  let deliver: ((result: CallbackResult) => void) | undefined;
  let expectedState: string | undefined;
  const received = new Promise<CallbackResult>((resolve) => (deliver = resolve));

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // stdout is reserved for MCP messages. Never log the code or state values.
    console.error(`[callback] ${req.method} ${url.pathname} (${[...url.searchParams.keys()].join(", ") || "파라미터 없음"})`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    // Ignore stray or forged hits (no params, or a state that isn't the one we issued) without delivering,
    // so a local process, a prefetching browser or a DNS-rebinding page can't abort the real flow. Keep
    // listening until the matching callback or the timeout.
    if ((!error && !code) || expectedState === undefined || !sameSecret(state, expectedState)) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><meta charset="utf-8"><p style="font-family:system-ui">잘못된 콜백 요청입니다.</p>`);
      return;
    }
    const ok = !error && code;
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Multi-Workspace for Notion</title>` +
        `<p style="font-family:system-ui;margin:20vh auto;max-width:420px">` +
        (ok ? "인증이 끝났습니다. 이 창을 닫고 터미널로 돌아가세요." : "인증이 취소되었거나 실패했습니다. 터미널을 확인하세요.") +
        `</p>`,
    );
    deliver?.(ok ? { code, state } : { error: error ?? "code가 없습니다" });
    deliver = undefined;
  };

  const servers: Server[] = [createServer(handler)];
  await listen(servers[0]!, 0, "127.0.0.1");
  const { port } = servers[0]!.address() as AddressInfo;
  // Carry on with IPv4 alone where IPv6 is disabled.
  const ipv6 = createServer(handler);
  if (await listen(ipv6, port, "::1").then(() => true, () => false)) servers.push(ipv6);

  return {
    redirectUrl: `http://localhost:${port}/callback`,
    async waitForCode(expected, timeoutMs) {
      expectedState = expected; // the handler only delivers a callback whose state matches this
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("인증 대기 시간이 지났습니다.")), timeoutMs);
      });
      try {
        const result = await Promise.race([received, timeout]);
        if ("error" in result) throw new Error(`Notion 인증 실패: ${result.error}`);
        return result.code;
      } finally {
        clearTimeout(timer);
      }
    },
    close() {
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
    },
  };
}

function sameSecret(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}
