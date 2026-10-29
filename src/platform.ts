import { win32 } from "node:path";

/**
 * A Windows system program by absolute path. Spawning a bare name on Windows searches the current directory first,
 * so a same-named file there would run instead.
 */
export const windowsTool = (relativeToSystem32: string) =>
  win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", relativeToSystem32);
