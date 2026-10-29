import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";
import { windowsTool } from "./platform.js";

const SERVICE = "multi-workspace-for-notion";

interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/**
 * Secrets in the OS credential store, through its command-line tools so no native module is needed: the macOS
 * Keychain, the Secret Service on Linux (secret-tool), and DPAPI-encrypted files on Windows. Never in plain text.
 * Secrets always travel over stdin/stdout, never in arguments, so they don't appear in the process list.
 */
export const keychain = {
  // Checked on every call: accounts built from a hand-edited config.json also become Windows file paths.
  async get(account: string) {
    assertSafeAccount(account);
    return store().get(account);
  },
  async set(account: string, value: string) {
    assertSafeAccount(account);
    await store().set(account, value);
  },
  async delete(account: string) {
    assertSafeAccount(account);
    await store().delete(account);
  },
};

function store(): SecretStore {
  if (process.platform === "darwin") return macKeychain;
  if (process.platform === "linux") return secretService;
  if (process.platform === "win32") return windowsDpapi;
  throw new Error(`지원하지 않는 운영체제입니다: ${process.platform}`);
}

/** Account names also end up in `security -i` lines and Windows file names, so keep them to a plain alphabet. */
function assertSafeAccount(account: string): void {
  if (!/^[A-Za-z0-9:_.-]+$/.test(account)) throw new Error(`키체인 계정 이름에 쓸 수 없는 문자: ${account}`);
}

// ---- Chunked stores: macOS Keychain and Linux Secret Service ----

// `security -i` cuts a line at about 4KB and secret-tool refuses long secrets, so values are stored in chunks.
const CHUNK_CHARS = 3000;

/** One plain item per account, holding only short ASCII (base64 or a manifest). */
interface ItemStore {
  read(account: string): Promise<string | undefined>;
  write(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

/**
 * Values are base64: no quoting issues, and the tools would otherwise mangle non-ASCII bytes and newlines.
 * Layout: `<account>` holds only "<generation>:<chunk count>"; the chunks live at `<account>.<generation>.<i>`.
 * All chunks of a new generation are written before `<account>` switches, so readers always see one whole generation.
 */
function chunked(items: ItemStore): SecretStore {
  const deleteChunks = async (account: string, manifest: string) => {
    const { generation, count } = parseManifest(manifest);
    for (let i = 0; i < count; i++) await items.remove(chunkAccount(account, generation, i));
  };
  return {
    async get(account) {
      // Read again if another process switched generations and deleted the old chunks mid-read.
      for (let attempt = 0; attempt < 2; attempt++) {
        const manifest = await items.read(account);
        if (manifest === undefined) return undefined;
        const { generation, count } = parseManifest(manifest);
        const chunks: string[] = [];
        for (let i = 0; i < count; i++) {
          const chunk = await items.read(chunkAccount(account, generation, i));
          if (chunk === undefined) break;
          chunks.push(chunk);
        }
        if (chunks.length === count) return Buffer.from(chunks.join(""), "base64").toString("utf8");
      }
      throw new Error(`키체인 값이 일부 없습니다: ${account}`);
    },
    async set(account, value) {
      const previous = await items.read(account);
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const generation = randomBytes(4).toString("hex");
      const count = Math.max(1, Math.ceil(encoded.length / CHUNK_CHARS));
      for (let i = 0; i < count; i++) {
        await items.write(chunkAccount(account, generation, i), encoded.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
      }
      await items.write(account, `${generation}:${count}`);
      if (previous !== undefined) await deleteChunks(account, previous);
    },
    async delete(account) {
      const manifest = await items.read(account);
      if (manifest === undefined) return;
      await items.remove(account);
      await deleteChunks(account, manifest);
    },
  };
}

function parseManifest(manifest: string): { generation: string; count: number } {
  const match = /^([0-9a-f]+):(\d+)$/.exec(manifest);
  if (!match) throw new Error(`키체인 값 형식이 올바르지 않습니다: ${manifest.slice(0, 20)}`);
  return { generation: match[1]!, count: Number(match[2]) };
}

const chunkAccount = (account: string, generation: string, index: number) => `${account}.${generation}.${index}`;

async function macRead(account: string): Promise<string | undefined> {
  const { code, stdout, stderr } = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
  if (code === 44) return undefined; // errSecItemNotFound
  if (code !== 0) throw new Error(`키체인 읽기 실패 (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

/** macOS Keychain generic passwords, via /usr/bin/security. Writes go to `security -i` over stdin. */
const macKeychain = chunked({
  read: macRead,
  /** value is always base64 or a manifest, and account passed assertSafeAccount, so -i's space splitting is safe. */
  async write(account, value) {
    const { stdout, stderr } = await run("/usr/bin/security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${account} -w ${value}\n`);
    // -i mode exits 0 even when the command fails, so read the value back to verify.
    if ((await macRead(account)) !== value) throw new Error(`키체인 쓰기 실패: ${(stderr || stdout).trim()}`);
  },
  async remove(account) {
    const { code, stderr } = await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
    if (code !== 0 && code !== 44) throw new Error(`키체인 삭제 실패 (${code}): ${stderr.trim()}`);
  },
});

/** Linux Secret Service (GNOME Keyring, KWallet, ...) via secret-tool; the secret goes in on stdin. */
const secretService = chunked({
  async read(account) {
    const { code, stdout, stderr } = await secretTool(["lookup", "service", SERVICE, "account", account]);
    // lookup exits 1 with no output when nothing is stored.
    if (code === 1 && !stderr.trim()) return undefined;
    if (code !== 0) throw new Error(`Secret Service 읽기 실패 (${code}): ${stderr.trim()}`);
    return stdout.trim();
  },
  async write(account, value) {
    const { code, stderr } = await secretTool(["store", `--label=${SERVICE} ${account}`, "service", SERVICE, "account", account], value);
    if (code !== 0) throw new Error(`Secret Service 쓰기 실패 (${code}): ${stderr.trim()}`);
  },
  async remove(account) {
    const { code, stderr } = await secretTool(["clear", "service", SERVICE, "account", account]);
    if (code !== 0 && stderr.trim()) throw new Error(`Secret Service 삭제 실패 (${code}): ${stderr.trim()}`);
  },
});

async function secretTool(args: string[], input?: string) {
  try {
    return await run("secret-tool", args, input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "토큰을 저장할 secret-tool이 없습니다. libsecret-tools(Debian/Ubuntu) 또는 libsecret(Fedora/Arch)를 설치하고, " +
          "GNOME Keyring이나 KWallet 같은 Secret Service가 실행 중인지 확인하세요.",
      );
    }
    throw error;
  }
}

// ---- Windows: DPAPI-encrypted files (only this Windows user can decrypt them) ----

const PROTECT = (op: "Protect" | "Unprotect") =>
  "Add-Type -AssemblyName System.Security; " +
  "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
  `$out = [Security.Cryptography.ProtectedData]::${op}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  "[Console]::Out.Write([Convert]::ToBase64String($out))";

// ':' is not allowed in Windows file names; '~' is outside the account alphabet, so the mapping stays one-to-one.
const dpapiPath = (account: string) => join(configDir(), "credentials", `${account.replace(/:/g, "~")}.dpapi`);

const windowsDpapi: SecretStore = {
  async get(account) {
    let sealed: string;
    try {
      sealed = await readFile(dpapiPath(account), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const plain = await powershell(PROTECT("Unprotect"), sealed);
    return Buffer.from(plain, "base64").toString("utf8");
  },
  async set(account, value) {
    const sealed = await powershell(PROTECT("Protect"), Buffer.from(value, "utf8").toString("base64"));
    await mkdir(join(configDir(), "credentials"), { recursive: true, mode: 0o700 });
    const tmp = `${dpapiPath(account)}.${process.pid}.tmp`;
    await writeFile(tmp, sealed, { mode: 0o600 });
    // Windows refuses to replace a file another process has open for a moment (an unlocked token read).
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, dpapiPath(account));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  },
  async delete(account) {
    await rm(dpapiPath(account), { force: true });
  },
};

async function powershell(script: string, input: string): Promise<string> {
  const exe = windowsTool("WindowsPowerShell\\v1.0\\powershell.exe");
  const { code, stdout, stderr } = await run(exe, ["-NoProfile", "-NonInteractive", "-Command", script], input);
  if (code !== 0) throw new Error(`Windows 자격 증명 암호화 실패 (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

// ---- shared ----

function run(command: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}
