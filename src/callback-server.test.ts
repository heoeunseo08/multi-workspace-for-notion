import assert from "node:assert/strict";
import { test } from "node:test";
import { startCallbackServer } from "./callback-server.js";

const hit = (base: string, query: string) => fetch(`${base}?${query}`).then((r) => r.status);

test("a stray or wrong-state callback can't abort the flow; the matching one still wins", async () => {
  const server = await startCallbackServer();
  try {
    const pending = server.waitForCode("the-real-state", 2000);
    // A paramless hit and a forged code with the wrong state must both be rejected without resolving.
    assert.equal(await hit(server.redirectUrl, ""), 400);
    assert.equal(await hit(server.redirectUrl, "code=forged&state=wrong"), 400);
    // The genuine callback still gets through.
    assert.equal(await hit(server.redirectUrl, "code=real&state=the-real-state"), 200);
    assert.equal(await pending, "real");
  } finally {
    server.close();
  }
});

test("an error callback with the matching state is reported as a failure", async () => {
  const server = await startCallbackServer();
  try {
    const rejected = assert.rejects(server.waitForCode("s2", 2000), /access_denied/);
    assert.equal(await hit(server.redirectUrl, "error=access_denied&state=s2"), 400);
    await rejected;
  } finally {
    server.close();
  }
});
