import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";

// The lock is held only for a few keychain reads and writes (hundreds of ms), so an older one was left by a dead process.
const STALE_MS = 10_000;
const RETRY_MS = 20;

/**
 * Lock shared by server processes, relying on mkdir being atomic.
 * shortcut: if two processes clear the same stale lock at once, one can delete the other's fresh lock. This needs a
 * process stalled for over 10s; store an owner token in the lock and check it before deleting if it ever shows up.
 */
export async function withFileLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const dir = join(configDir(), "locks");
  const path = join(dir, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_MS) await rm(path, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
