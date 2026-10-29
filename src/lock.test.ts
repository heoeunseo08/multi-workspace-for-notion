import assert from "node:assert/strict";
import { mkdtemp, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileLock } from "./lock.js";

process.env.MWN_CONFIG_DIR = await mkdtemp(join(tmpdir(), "mwn-lock-"));

test("only one holder of a lock name at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  await Promise.all(
    [1, 2, 3, 4].map((n) =>
      withFileLock("workspace:work", async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setTimeout(r, 15));
        order.push(n);
        active--;
      }),
    ),
  );
  assert.equal(maxActive, 1);
  assert.equal(order.length, 4);
});

test("releases the lock when fn throws", async () => {
  await assert.rejects(withFileLock("workspace:fail", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withFileLock("workspace:fail", async () => "ok"), "ok");
});

test("clears a stale lock left by a dead process", async () => {
  const path = join(process.env.MWN_CONFIG_DIR!, "locks", "workspace_stale.lock");
  await mkdir(path, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
  assert.equal(await withFileLock("workspace:stale", async () => "ok"), "ok");
});
