import { randomBytes } from "node:crypto";
import {
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentialAccount } from "./config.js";
import { keychain } from "./keychain.js";
import { withFileLock } from "./lock.js";
import { NOTION_MCP_URL } from "./notion.js";

/** One workspace's secrets, stored as JSON in keychain account `workspace:<workspace id>`. */
export interface StoredCredentials {
  redirectUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
}

/**
 * The SDK OAuthClientProvider for one workspace. The SDK's auth() does DCR and PKCE;
 * this class only keeps the results in the keychain.
 *
 * A provider for an already connected workspace has no onRedirect, so it fails as soon as browser
 * sign-in would be needed. The workspace then has to be reconnected with workspace_connect.
 */
export class WorkspaceAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  private expectedState: string | undefined;
  /** The keychain value was seen or saved. If it disappears later, the workspace was disconnected. */
  private persisted = false;

  private constructor(
    private account: string,
    private stored: StoredCredentials,
    private readonly onRedirect: ((url: URL) => void | Promise<void>) | undefined,
  ) {}

  /**
   * For a new connection. The workspace (and so its ID) is only known after sign-in, so this saves under a
   * temporary account that the caller moves to `workspace:<id>` with moveTo(). redirectUrl is the callback server's address.
   */
  static forNewConnection(redirectUrl: string, onRedirect: (url: URL) => void | Promise<void>) {
    return new WorkspaceAuthProvider(`pending:${randomBytes(8).toString("hex")}`, { redirectUrl }, onRedirect);
  }

  /** For a connected workspace. Undefined when nothing is stored. */
  static async forExisting(workspaceId: string): Promise<WorkspaceAuthProvider | undefined> {
    const raw = await keychain.get(credentialAccount(workspaceId));
    if (raw === undefined) return undefined;
    const provider = new WorkspaceAuthProvider(credentialAccount(workspaceId), JSON.parse(raw) as StoredCredentials, undefined);
    provider.persisted = true;
    return provider;
  }

  get redirectUrl(): string {
    return this.stored.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Multi-Workspace for Notion",
      redirect_uris: [this.stored.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.expectedState = randomBytes(24).toString("base64url");
    return this.expectedState;
  }

  /** The state the callback must echo back. Set once auth() has started an authorization. */
  get pendingState(): string | undefined {
    return this.expectedState;
  }

  clientInformation() {
    return this.stored.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    await this.update((s) => (s.clientInformation = clientInformation));
  }

  /**
   * Each Claude session runs its own server process, so re-read the keychain every time to pick up tokens another
   * process refreshed. Refresh tokens are single-use: a stale one from memory fails with invalid_grant.
   */
  async tokens() {
    await this.reload();
    return this.stored.tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    await this.update((s) => (s.tokens = tokens));
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    if (!this.onRedirect) {
      throw new Error("저장된 인증이 더 이상 유효하지 않습니다. workspace_connect로 다시 연결하세요.");
    }
    await this.onRedirect(authorizationUrl);
  }

  // The PKCE verifier lives only for one authorization, so it stays in memory.
  saveCodeVerifier(codeVerifier: string) {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("PKCE code verifier가 없습니다.");
    return this.verifier;
  }

  discoveryState() {
    return this.stored.discoveryState;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState) {
    await this.update((s) => (s.discoveryState = state));
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    // When a refresh fails with invalid_grant, the SDK calls this with "tokens" and retries right away.
    // Another process (or a concurrent call here) may have used the same refresh token first, in which case the
    // keychain already holds new tokens, and deleting them would sign out every session. So keep them:
    // the retry re-reads the keychain through tokens(), and if the tokens really are dead the retry fails with the error.
    if (scope === "tokens") return this.waitForRotation();
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "verifier") return;
    await this.update((s) => {
      if (scope === "all" || scope === "client") delete s.clientInformation;
      if (scope === "all") delete s.tokens;
      if (scope === "all" || scope === "discovery") delete s.discoveryState;
    });
  }

  /**
   * The process that won the refresh race may not have saved its new tokens yet when this one gets invalid_grant,
   * and the SDK retries only once. Wait until the stored refresh token differs from the one just rejected, or give up.
   */
  private async waitForRotation() {
    const rejected = this.stored.tokens?.refresh_token;
    // A deadline, not a count: each read can be slow (a PowerShell start on Windows).
    for (const deadline = Date.now() + ROTATION_WAIT_MS; Date.now() < deadline; ) {
      const raw = await keychain.get(this.account);
      if (raw === undefined || (JSON.parse(raw) as StoredCredentials).tokens?.refresh_token !== rejected) return;
      await new Promise((resolve) => setTimeout(resolve, ROTATION_POLL_MS));
    }
  }

  /** For a connection that failed or was refused: deletes the stored credentials and revokes them on Notion. */
  async discard() {
    const raw = await keychain.get(this.account);
    await keychain.delete(this.account);
    if (raw !== undefined) await revokeTokens(JSON.parse(raw) as StoredCredentials);
  }

  /** Moves the stored credentials to another keychain account (a new connection's final `workspace:<id>`). */
  async moveTo(account: string) {
    const raw = await keychain.get(this.account);
    if (raw === undefined) throw new Error("저장된 인증이 없습니다.");
    await keychain.set(account, raw);
    await keychain.delete(this.account);
    this.account = account;
  }

  private async reload() {
    const raw = await keychain.get(this.account);
    if (raw !== undefined) this.stored = JSON.parse(raw) as StoredCredentials;
    // Disconnected in another session: stop using the copy in memory too.
    else if (this.persisted) throw new Error(DISCONNECTED_ELSEWHERE);
  }

  /**
   * Writing the in-memory copy wholesale would overwrite newer tokens another process saved meanwhile.
   * So take the lock, re-read the keychain and change only the given fields.
   * If the value vanished because another process disconnected the workspace, write nothing,
   * so deleted tokens stay deleted.
   */
  private async update(change: (stored: StoredCredentials) => void) {
    await withFileLock(this.account, async () => {
      const raw = await keychain.get(this.account);
      if (raw !== undefined) this.stored = JSON.parse(raw) as StoredCredentials;
      else if (this.persisted) throw new Error(DISCONNECTED_ELSEWHERE);
      change(this.stored);
      await keychain.set(this.account, JSON.stringify(this.stored));
      this.persisted = true;
    });
  }
}

const DISCONNECTED_ELSEWHERE = "이 워크스페이스는 다른 세션에서 연결이 해제되었습니다. 새 대화에서 다시 시도하세요.";
const REVOKE_TIMEOUT_MS = 5000;
// A concurrent winner saves within milliseconds; a truly dead token only delays its error by this much.
const ROTATION_WAIT_MS = 2000;
const ROTATION_POLL_MS = 100;

/**
 * Revokes the tokens on Notion (RFC 7009). Never throws, so it can't block a disconnect; returns false on failure.
 * The refresh token goes first, which usually also invalidates access tokens from the same grant.
 */
export async function revokeTokens(stored: StoredCredentials, fetchFn: FetchLike = fetch): Promise<boolean> {
  const client = stored.clientInformation;
  const tokens = [
    ["refresh_token", stored.tokens?.refresh_token],
    ["access_token", stored.tokens?.access_token],
  ].filter((t): t is [string, string] => typeof t[1] === "string");
  if (!client?.client_id || tokens.length === 0) return false;

  const timed: FetchLike = (url, init) => fetchFn(url, { ...init, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) });
  try {
    // The OIDC metadata type lacks revocation_endpoint, so read the field directly.
    const revocationEndpoint = (info?: OAuthServerInfo) =>
      (info?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
    const endpoint =
      revocationEndpoint(stored.discoveryState) ??
      revocationEndpoint(await discoverOAuthServerInfo(NOTION_MCP_URL, { fetchFn: timed }));
    if (!endpoint) return false;
    for (const [hint, token] of tokens) {
      const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.client_id });
      if ("client_secret" in client && client.client_secret) body.set("client_secret", client.client_secret);
      const response = await timed(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}
