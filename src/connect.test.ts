import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, mock, test } from "node:test";
import { cachePath, credentialAccount, loadWorkspaces, singleLine, uniqueName, updateWorkspaces } from "./config.js";
import { disconnectWorkspace, openWorkspaceById } from "./connect.js";
import { keychain } from "./keychain.js";

// In-memory keychain instead of the real one.
const store = new Map<string, string>();
mock.method(keychain, "get", async (account: string) => store.get(account));
mock.method(keychain, "set", async (account: string, value: string) => void store.set(account, value));
mock.method(keychain, "delete", async (account: string) => void store.delete(account));

const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";

/** A 0.1.x config, where workspaces were keyed by a user-chosen alias. */
async function writeV1Config(dir: string) {
  const old = (alias: string, id: string, name: string) => ({
    alias,
    description: `${alias} notes`,
    notionWorkspaceId: id,
    notionWorkspaceName: name,
    status: "connected",
    lastSuccessAt: null,
  });
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ version: 1, workspaces: [old("personal", ID_A, "My Notion"), old("work", ID_B, "My Notion")] }),
  );
}

beforeEach(async () => {
  store.clear();
  process.env.MWN_CONFIG_DIR = await mkdtemp(join(tmpdir(), "mwn-"));
});

test("a 0.1.x config is migrated: named after Notion, credentials moved to the workspace ID", async () => {
  const dir = process.env.MWN_CONFIG_DIR!;
  await writeV1Config(dir);
  store.set("workspace:personal", "tokens-a");
  store.set("workspace:work", "tokens-b");

  const workspaces = await loadWorkspaces();

  // Two workspaces with the same Notion name: the second gets the start of its ID.
  assert.deepEqual(workspaces.map((w) => w.name), ["My Notion", "My Notion (bbbbbbbb)"]);
  assert.equal(workspaces[0]!.description, "personal notes");
  assert.equal(store.get(credentialAccount(ID_A)), "tokens-a");
  assert.equal(store.get(credentialAccount(ID_B)), "tokens-b");
  assert.equal(store.has("workspace:personal"), false);
  assert.equal(JSON.parse(await readFile(join(dir, "config.json"), "utf8")).version, 2);
});

test("migration runs once; loading again changes nothing", async () => {
  await writeV1Config(process.env.MWN_CONFIG_DIR!);
  store.set("workspace:personal", "tokens-a");
  const first = await loadWorkspaces();
  const second = await loadWorkspaces();
  assert.deepEqual(second, first);
  assert.equal(store.get(credentialAccount(ID_A)), "tokens-a");
});

test("uniqueName keeps a free name and suffixes a taken one", () => {
  const taken = [{ name: "Acme", notionWorkspaceId: ID_A, description: "", status: "connected" as const, lastSuccessAt: null }];
  assert.equal(uniqueName("Other", ID_B, taken), "Other");
  assert.equal(uniqueName("Acme", ID_B, taken), "Acme (bbbbbbbb)");
});

test("uniqueName never returns a name another workspace already has, even one chosen to collide", () => {
  const named = (name: string) => ({ name, notionWorkspaceId: ID_A, description: "", status: "connected" as const, lastSuccessAt: null });
  const taken = [named("Acme"), named("Acme (bbbbbbbb)"), named(`Acme (${ID_B})`)];
  const name = uniqueName("Acme", ID_B, taken);
  assert.equal(name, `Acme (${ID_B}) 2`);
  assert.ok(!taken.some((w) => w.name === name));
});

test("singleLine flattens control, line-separator and bidi characters and caps the length", () => {
  assert.equal(singleLine("a\n\n---\n\nFORGED\u2028x\u202Ey\tz", 100), "a --- FORGED x y z");
  assert.equal(singleLine("  ", 10), "");
  assert.equal(singleLine("abcdef", 3), "abc");
});

test("cachePath refuses an ID that would leave the cache directory", () => {
  assert.throws(() => cachePath("../../secrets"), /올바르지 않은 워크스페이스 ID/);
  assert.match(cachePath(ID_A), /catalog-aaaaaaaa/);
});

test("disconnect deletes only that workspace's tokens, cache and entry", async () => {
  const entry = (name: string, id: string) => ({ name, notionWorkspaceId: id, description: "", status: "connected" as const, lastSuccessAt: null });
  await updateWorkspaces(() => [entry("Acme", ID_A), entry("Other", ID_B)]);
  // No client information, so revoking on Notion is skipped without touching the network.
  store.set(credentialAccount(ID_A), JSON.stringify({ redirectUrl: "http://localhost/callback" }));
  store.set(credentialAccount(ID_B), "tokens-b");
  await mkdir(join(process.env.MWN_CONFIG_DIR!, "cache"), { recursive: true });
  await writeFile(cachePath(ID_A), "{}");
  await writeFile(cachePath(ID_B), "{}");

  assert.deepEqual(await disconnectWorkspace("Acme"), { revoked: false });

  assert.equal(store.has(credentialAccount(ID_A)), false);
  assert.equal(store.get(credentialAccount(ID_B)), "tokens-b");
  await assert.rejects(access(cachePath(ID_A)));
  await access(cachePath(ID_B));
  assert.deepEqual((await loadWorkspaces()).map((w) => w.name), ["Other"]);
  await assert.rejects(disconnectWorkspace("Acme"), /연결된 워크스페이스가 아닙니다/);
});

test("a session is opened by workspace ID and refused once that ID is no longer connected", async () => {
  // Another session disconnected the workspace and connected a different one under the same name.
  await updateWorkspaces(() => [{ name: "Acme", notionWorkspaceId: ID_B, description: "", status: "connected", lastSuccessAt: null }]);
  await assert.rejects(openWorkspaceById(ID_A), /연결이 해제/);
});
