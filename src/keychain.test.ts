import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keychain } from "./keychain.js";

// Uses the real credential store with a throwaway account. On Windows (DPAPI files, also in CI) it always runs; on
// macOS only outside CI, where a login Keychain may be locked; on Linux only when a Secret Service is running.
// The Windows store keeps its encrypted files under the config dir; keep them out of the real one.
if (process.platform === "win32") process.env.MWN_CONFIG_DIR = await mkdtemp(join(tmpdir(), "mwn-store-"));

const skip =
  process.platform === "win32"
    ? false
    : process.platform === "darwin"
      ? Boolean(process.env.CI)
      : !process.env.MWN_TEST_SECRET_SERVICE;

test("stores long and non-ASCII values intact, overwrites, and deletes", { skip }, async () => {
  const account = `test:selftest-${randomBytes(4).toString("hex")}`;
  // Over 4KB (security -i cuts lines there) plus Korean, quotes and a newline (-w would print those as hex).
  const value = JSON.stringify({ token: "x".repeat(16_000), note: "한글 ' \" 줄바꿈\n" });
  try {
    assert.equal(await keychain.get(account), undefined);
    await keychain.set(account, value);
    assert.equal(await keychain.get(account), value);
    await keychain.set(account, "short");
    assert.equal(await keychain.get(account), "short");
  } finally {
    await keychain.delete(account);
  }
  assert.equal(await keychain.get(account), undefined);
});

test("refuses account names that could leave the store's namespace, on every call", async () => {
  for (const op of [() => keychain.get("workspace:..\\..\\x"), () => keychain.delete("a b"), () => keychain.set("a/b", "v")]) {
    await assert.rejects(op, /쓸 수 없는 문자/);
  }
});
