import { spawn, type ChildProcess } from "node:child_process";
import type { ConfirmAnswer } from "./management.js";
import { windowsTool } from "./platform.js";

const CONFIRM_SECONDS = 10 * 60;
const TITLE = "Multi-Workspace for Notion";
const YES = "해제";
const NO = "취소";

export interface DialogResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Closed by us because the request was cancelled or the client went away. */
  cancelled?: boolean;
}
export type RunDialog = (message: string, signal?: AbortSignal) => Promise<DialogResult>;

/**
 * Asks with a native system dialog, for clients that can't show an MCP confirmation (Claude Desktop, the VS Code
 * extension). It is drawn by the OS outside the chat, so the model can't answer it. The message is always passed as
 * data (an argument or stdin), never pasted into script text, so it can't inject commands.
 */
export async function askWithSystemDialog(
  message: string,
  run: RunDialog = SYSTEM_DIALOGS[process.platform] ?? unavailable,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<ConfirmAnswer> {
  if (signal?.aborted) return "cancelled";
  let result: DialogResult;
  try {
    result = await run(message, signal);
  } catch {
    return "unsupported";
  }
  if (result.cancelled || signal?.aborted) return "cancelled";
  if (result.timedOut) return "no_answer";
  return (READERS[platform] ?? (() => "unsupported"))(result);
}

const READERS: Partial<Record<NodeJS.Platform, (r: DialogResult) => ConfirmAnswer>> = {
  // display dialog prints "button returned:해제, gave up:false"; the cancel button exits with "User canceled. (-128)".
  darwin: (r) =>
    r.stderr.includes("-128")
      ? "declined"
      : r.code !== 0
        ? "unsupported"
        : r.stdout.includes("gave up:true")
          ? "no_answer"
          : r.stdout.includes(`button returned:${YES}`)
            ? "accepted"
            : "declined",
  // MessageBox prints the button: Yes or No.
  win32: (r) => (r.code !== 0 ? "unsupported" : r.stdout.trim() === "Yes" ? "accepted" : "declined"),
  // zenity: 0 yes, 1 no, 5 timeout. kdialog: 0 continue, 2 cancel. Anything else means no dialog could be shown.
  // Without a display both also exit 1 but say so on stderr; that is not the user saying no.
  linux: (r) =>
    r.code === 0
      ? "accepted"
      : NO_DISPLAY.test(r.stderr)
        ? "unsupported"
        : r.code === 1 || r.code === 2
          ? "declined"
          : r.code === 5
            ? "no_answer"
            : "unsupported",
};

const NO_DISPLAY = /cannot open display|could not connect to display|no display|failed to open display|qt\.qpa/i;

/** kdialog guesses whether text is rich text; wrapping it in <qt> with escaped content always shows it as written. */
export const kdialogText = (message: string) =>
  `<qt>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</qt>`;

const SYSTEM_DIALOGS: Partial<Record<NodeJS.Platform, RunDialog>> = {
  darwin: (message, signal) =>
    run("/usr/bin/osascript", [
      "-e",
      "on run argv",
      "-e",
      `display dialog (item 1 of argv) with title "${TITLE}" buttons {"${NO}", "${YES}"} ` +
        `default button "${NO}" cancel button "${NO}" with icon caution giving up after ${CONFIRM_SECONDS}`,
      "-e",
      "end run",
      message,
    ], undefined, undefined, signal),
  win32: (message, signal) =>
    run(
      windowsTool("WindowsPowerShell\\v1.0\\powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // Node writes UTF-8; without this PowerShell reads stdin in the console code page and Korean comes out garbled.
        "[Console]::InputEncoding = [Text.Encoding]::UTF8; " +
          "Add-Type -AssemblyName System.Windows.Forms; " +
          "$m = [Console]::In.ReadToEnd(); " +
          `[System.Windows.Forms.MessageBox]::Show($m, '${TITLE}', 'YesNo', 'Warning', 'Button2', 'DefaultDesktopOnly')`,
      ],
      message,
      CONFIRM_SECONDS * 1000,
      signal,
    ),
  linux: async (message, signal) => {
    try {
      return await run("zenity", [
        "--question",
        `--title=${TITLE}`,
        "--no-markup",
        `--text=${message}`,
        `--ok-label=${YES}`,
        `--cancel-label=${NO}`,
        "--default-cancel",
        `--timeout=${CONFIRM_SECONDS}`,
      ], undefined, undefined, signal);
    } catch {
      // KDE desktops often have kdialog instead.
      return await run("kdialog", ["--title", TITLE, "--warningcontinuecancel", kdialogText(message), "--continue-label", YES], undefined, CONFIRM_SECONDS * 1000, signal);
    }
  },
};

const unavailable: RunDialog = async () => {
  throw new Error("no system dialog on this platform");
};

/** GTK/Qt reject non-ASCII arguments (our Korean text) outright unless the locale is UTF-8. */
function utf8Env(): NodeJS.ProcessEnv {
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  return /utf-?8/i.test(locale) ? process.env : { ...process.env, LC_ALL: "C.UTF-8" };
}

// A dialog must not outlive this server: nobody would be left to act on its answer, and it would only confuse.
const openDialogs = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of openDialogs) child.kill();
});

function run(command: string, args: string[], input?: string, timeoutMs?: number, signal?: AbortSignal): Promise<DialogResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: process.platform === "linux" ? utf8Env() : process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), child.kill()), timeoutMs) : undefined;
    // Take the dialog off the screen: an answer to a dropped request must not be possible.
    const cancel = () => ((cancelled = true), child.kill());
    signal?.addEventListener("abort", cancel, { once: true });
    openDialogs.add(child);
    const done = () => (clearTimeout(timer), signal?.removeEventListener("abort", cancel), openDialogs.delete(child));
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => (done(), reject(error)));
    child.on("close", (code) => (done(), resolve({ code, stdout, stderr, timedOut, cancelled })));
    if (input !== undefined) child.stdin!.end(input);
  });
}
