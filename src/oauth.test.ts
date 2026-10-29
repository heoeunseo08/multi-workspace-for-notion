import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, mock, test } from "node:test";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { keychain } from "./keychain.js";
import { credentialAccount } from "./config.js";
import { WorkspaceAuthProvider, revokeTokens, type StoredCredentials } from "./oauth.js";

process.env.MWN_CONFIG_DIR = await mkdtemp(join(tmpdir(), "mwn-oauth-")); // where lock files go

const SERVER_URL = "https://mcp.example.test/mcp";
const ISSUER = "https://auth.example.test";

// In-memory keychain. Providers share it, standing in for several processes.
const store = new Map<string, string>();
mock.method(keychain, "get", async (account: string) => store.get(account));
// Writes take time like the real keychain, so unlocked overlapping writes would show up.
mock.method(keychain, "set", async (account: string, value: string) => {
  await new Promise((r) => setTimeout(r, 5));
  store.set(account, value);
});
mock.method(keychain, "delete", async (account: string) => void store.delete(account));

/** Fake token server that accepts each refresh token once and rotates it. */
function rotatingServer(firstRefreshToken: string) {
  let valid = firstRefreshToken;
  let issued = 0;
  const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({ resource: SERVER_URL, authorization_servers: [ISSUER] });
    }
    if (url.origin === ISSUER && url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.origin === ISSUER && url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body));
      await new Promise((r) => setTimeout(r, 10)); // let concurrent requests overlap
      if (body.get("refresh_token") !== valid) {
        return Response.json({ error: "invalid_grant", error_description: "refresh token already used" }, { status: 400 });
      }
      issued += 1;
      valid = `refresh-${issued + 1}`;
      return Response.json({ access_token: `access-${issued + 1}`, token_type: "bearer", expires_in: 3600, refresh_token: valid });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, current: () => valid };
}

function seed(alias: string, refreshToken: string) {
  const stored: StoredCredentials = {
    redirectUrl: "http://localhost:1/callback",
    clientInformation: { client_id: "client-1" },
    tokens: { access_token: "access-1", token_type: "bearer", refresh_token: refreshToken },
  };
  store.set(credentialAccount(alias), JSON.stringify(stored));
}

const storedTokens = (alias: string) =>
  (JSON.parse(store.get(credentialAccount(alias)) ?? "{}") as StoredCredentials).tokens;

beforeEach(() => store.clear());

test("picks up tokens another process refreshed", async () => {
  seed("work", "refresh-1");
  const server = rotatingServer("refresh-1");
  // Both sessions start together, holding the same tokens in memory.
  const sessionA = (await WorkspaceAuthProvider.forExisting("work"))!;
  const sessionB = (await WorkspaceAuthProvider.forExisting("work"))!;

  assert.equal(await auth(sessionA, { serverUrl: SERVER_URL, fetchFn: server.fetchFn }), "AUTHORIZED");
  // B still holds refresh-1 in memory, but A already used it.
  assert.equal(await auth(sessionB, { serverUrl: SERVER_URL, fetchFn: server.fetchFn }), "AUTHORIZED");

  assert.equal(storedTokens("work")?.refresh_token, server.current());
});

test("concurrent refreshes keep the stored tokens", async () => {
  seed("work", "refresh-1");
  const server = rotatingServer("refresh-1");
  const sessionA = (await WorkspaceAuthProvider.forExisting("work"))!;
  const sessionB = (await WorkspaceAuthProvider.forExisting("work"))!;

  // Both refresh with refresh-1. One gets invalid_grant and must re-read the keychain and retry.
  const results = await Promise.all([
    auth(sessionA, { serverUrl: SERVER_URL, fetchFn: server.fetchFn }),
    auth(sessionB, { serverUrl: SERVER_URL, fetchFn: server.fetchFn }),
  ]);

  assert.deepEqual(results, ["AUTHORIZED", "AUTHORIZED"]);
  assert.equal(storedTokens("work")?.refresh_token, server.current());
});

test("after invalid_grant, waits for another session's slow save so the SDK's single retry sees new tokens", async () => {
  seed("work", "refresh-1");
  const loser = (await WorkspaceAuthProvider.forExisting("work"))!;
  await loser.tokens();
  // The winner's save lands 300 ms later, as on a busy machine.
  setTimeout(() => seed("work", "refresh-2"), 300);
  const started = Date.now();
  await loser.invalidateCredentials("tokens");
  assert.ok(Date.now() - started >= 250, "returned before the new tokens were saved");
  assert.equal((await loser.tokens())?.refresh_token, "refresh-2");
});

test("a refresh token nobody rotated is waited on only briefly", async () => {
  seed("work", "dead");
  const session = (await WorkspaceAuthProvider.forExisting("work"))!;
  await session.tokens();
  const started = Date.now();
  await session.invalidateCredentials("tokens");
  const waited = Date.now() - started;
  assert.ok(waited >= 1900 && waited < 3000, `waited ${waited} ms`);
});

test("a truly invalid token errors but stays stored", async () => {
  seed("work", "revoked");
  const server = rotatingServer("something-else");
  const session = (await WorkspaceAuthProvider.forExisting("work"))!;

  await assert.rejects(auth(session, { serverUrl: SERVER_URL, fetchFn: server.fetchFn }));
  assert.equal(storedTokens("work")?.refresh_token, "revoked");
});

test("concurrent saves keep each other's changes", async () => {
  seed("work", "refresh-1");
  const sessionA = (await WorkspaceAuthProvider.forExisting("work"))!;
  const sessionB = (await WorkspaceAuthProvider.forExisting("work"))!;

  await Promise.all([
    sessionA.saveTokens({ access_token: "access-a", token_type: "bearer", refresh_token: "refresh-a" }),
    sessionB.saveClientInformation({ client_id: "client-b" }),
  ]);

  const stored = JSON.parse(store.get(credentialAccount("work"))!) as StoredCredentials;
  assert.equal(stored.tokens?.refresh_token, "refresh-a");
  assert.equal(stored.clientInformation?.client_id, "client-b");
});

test("never restores tokens another session deleted on disconnect", async () => {
  seed("work", "refresh-1");
  const session = (await WorkspaceAuthProvider.forExisting("work"))!;
  store.delete(credentialAccount("work"));

  await assert.rejects(session.saveTokens({ access_token: "a", token_type: "bearer", refresh_token: "r" }), /연결이 해제/);
  assert.equal(store.has(credentialAccount("work")), false);
  // Nor keeps using the copy in memory.
  await assert.rejects(session.tokens(), /연결이 해제/);
});

const withTokens: StoredCredentials = {
  redirectUrl: "http://localhost:1/callback",
  clientInformation: { client_id: "client-1" },
  tokens: { access_token: "access-1", token_type: "bearer", refresh_token: "refresh-1" },
  discoveryState: {
    authorizationServerUrl: ISSUER,
    authorizationServerMetadata: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      revocation_endpoint: `${ISSUER}/revoke`,
      response_types_supported: ["code"],
    },
  },
};

test("disconnect revokes the refresh and access tokens per RFC 7009", async () => {
  const requests: { url: string; body: Record<string, string> }[] = [];
  const fetchFn = async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: Object.fromEntries(new URLSearchParams(String(init?.body))) });
    return new Response(null, { status: 200 });
  };
  assert.equal(await revokeTokens(withTokens, fetchFn), true);
  assert.deepEqual(requests, [
    { url: `${ISSUER}/revoke`, body: { token: "refresh-1", token_type_hint: "refresh_token", client_id: "client-1" } },
    { url: `${ISSUER}/revoke`, body: { token: "access-1", token_type_hint: "access_token", client_id: "client-1" } },
  ]);
});

test("revocation returns false instead of throwing when it fails or can't run", async () => {
  assert.equal(await revokeTokens(withTokens, async () => new Response(null, { status: 503 })), false);
  assert.equal(await revokeTokens(withTokens, async () => { throw new Error("offline"); }), false);
  assert.equal(await revokeTokens({ ...withTokens, tokens: undefined }, async () => { throw new Error("must not be called"); }), false);
});
