import {
  spawn as nodeSpawn,
  type SpawnOptions,
} from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, win32 } from "node:path";

export const MINIMUM_CODEX_CLI_VERSION = "0.144.1";

export interface CodexCliVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
  prerelease?: string;
}

export interface AssertCodexCliVersionOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  comspec?: string;
  terminationGraceMs?: number;
  probeSpawn?: CodexProbeSpawn;
  runTerminationCommand?: (
    file: string,
    args: string[],
  ) => Promise<void>;
  runVersion?: (
    spec: CodexProcessSpec,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => string | Promise<string>;
}

export class CodexCliUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CodexCliUnavailableError";
  }
}

export interface CodexProcessSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface CodexProbeReadable {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): this;
}

export interface CodexProbeProcess {
  pid?: number;
  stdout: CodexProbeReadable;
  stderr: CodexProbeReadable;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal: NodeJS.Signals): boolean;
}

export type CodexProbeSpawn = (
  file: string,
  args: string[],
  options: SpawnOptions,
) => CodexProbeProcess;

export interface ProbeCodexVersionOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  terminationGraceMs?: number;
  spawn?: CodexProbeSpawn;
  runTerminationCommand?: (
    file: string,
    args: string[],
  ) => Promise<void>;
}

export class CodexCliProbeTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly cause?: unknown,
  ) {
    super(`Codex CLI version probe timed out after ${timeoutMs}ms`);
    this.name = "CodexCliProbeTimeoutError";
  }
}

export interface CodexProcessSpecOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  comspec?: string;
}

export const DEFAULT_CODEX_VERSION_TIMEOUT_MS = 3_000;
const DEFAULT_PROBE_TERMINATION_GRACE_MS = 500;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

export function probeCodexVersion(
  spec: CodexProcessSpec,
  options: ProbeCodexVersionOptions,
): Promise<string> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as CodexProbeSpawn);
  const child = spawn(spec.file, spec.args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const append = (existing: Buffer, chunk: Uint8Array | string): Buffer => {
    const combined = Buffer.concat([existing, Buffer.from(chunk)]);
    return combined.length > MAX_PROBE_OUTPUT_BYTES
      ? combined.subarray(combined.length - MAX_PROBE_OUTPUT_BYTES)
      : combined;
  };
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.on("error", (error) => {
      if (!timedOut) settle(() => reject(error));
    });
    child.on("close", (code, signal) => {
      if (!closed) {
        closed = true;
        resolveClosed();
      }
      if (timedOut) return;
      if (code === 0) {
        settle(() => resolve(stdout.toString("utf8")));
      } else {
        const detail = stderr.toString("utf8").trim();
        settle(() =>
          reject(
            new Error(
              detail ||
                `Codex CLI version probe exited with status ${String(code)}${
                  signal ? ` (${signal})` : ""
                }`,
            ),
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateTimedOutProbe(
        child,
        spec,
        closedPromise,
        () => closed,
        options.terminationGraceMs ?? DEFAULT_PROBE_TERMINATION_GRACE_MS,
        options.runTerminationCommand,
      ).then(
        () => settle(() => reject(new CodexCliProbeTimeoutError(options.timeoutMs))),
        (error: unknown) =>
          settle(() =>
            reject(new CodexCliProbeTimeoutError(options.timeoutMs, error)),
          ),
      );
    }, options.timeoutMs);
  });
}

export function parseCodexVersion(output: string): CodexCliVersion {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?\b/);
  if (!match) {
    throw new CodexCliUnavailableError(
      `Could not parse Codex CLI version from: ${JSON.stringify(output.trim())}`,
    );
  }
  const suffix = match[4] ?? "";
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}${suffix}`,
    ...(suffix.startsWith("-") ? { prerelease: suffix.slice(1) } : {}),
  };
}

export async function assertCodexCliVersion(
  options: AssertCodexCliVersionOptions = {},
): Promise<CodexCliVersion> {
  const command = options.command ?? "codex";
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_VERSION_TIMEOUT_MS;
  const spec = buildCodexProcessSpec(command, ["--version"], {
    platform: options.platform,
    env,
    fileExists: options.fileExists,
    comspec: options.comspec,
  });
  const runVersion =
    options.runVersion ??
    ((commandSpec: CodexProcessSpec, commandEnv: NodeJS.ProcessEnv) =>
      probeCodexVersion(commandSpec, {
        env: commandEnv,
        timeoutMs,
        terminationGraceMs: options.terminationGraceMs,
        spawn: options.probeSpawn,
        runTerminationCommand: options.runTerminationCommand,
      }));

  let output: string;
  try {
    output = await runVersion(spec, env, timeoutMs);
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    if (isTimeoutError(error)) {
      throw new CodexCliUnavailableError(
        `Codex CLI version check timed out after ${timeoutMs}ms${detail}. Check the Codex installation and PATH, then restart Obsidian.`,
        error,
      );
    }
    throw new CodexCliUnavailableError(
      `Codex CLI was not found${detail}. Install or update Codex CLI and ensure "codex" is available on PATH.`,
      error,
    );
  }

  const version = parseCodexVersion(output);
  const minimum = parseCodexVersion(MINIMUM_CODEX_CLI_VERSION);
  if (compareVersions(version, minimum) < 0) {
    throw new CodexCliUnavailableError(
      `Found ${version.raw}, but Hyo requires ${MINIMUM_CODEX_CLI_VERSION} or newer. Update with: curl -fsSL https://chatgpt.com/codex/install.sh | sh — then restart Obsidian.`,
    );
  }
  return version;
}

export function buildElectronSafePath(
  currentPath = process.env.PATH ?? "",
  home = process.env.HOME ?? "",
  platform: NodeJS.Platform = process.platform,
  appData = process.env.APPDATA ?? "",
): string {
  const pathDelimiter = platform === "win32" ? win32.delimiter : delimiter;
  if (platform === "win32") {
    const candidates = [
      appData ? win32.join(appData, "npm") : "",
      home ? win32.join(home, "AppData", "Roaming", "npm") : "",
      ...currentPath.split(pathDelimiter),
    ].filter(Boolean);
    return [...new Set(candidates)].join(pathDelimiter);
  }

  const candidates = [
    home ? `${home}/.local/bin` : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...currentPath.split(pathDelimiter),
  ].filter(Boolean);
  return [...new Set(candidates)].join(pathDelimiter);
}

export function buildCodexProcessSpec(
  command: string,
  args: string[],
  options: CodexProcessSpecOptions = {},
): CodexProcessSpec {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args };

  const env = options.env ?? process.env;
  const resolved = resolveWindowsCommand(
    command,
    env,
    options.fileExists ?? existsSync,
  );
  if (!/\.(?:cmd|bat)$/i.test(resolved)) {
    return { file: resolved, args };
  }

  assertSafeWindowsShellToken(resolved);
  for (const argument of args) assertSafeWindowsShellToken(argument);
  const argumentText = args.map(quoteWindowsShellToken).join(" ");
  const commandLine = `""${resolved}"${argumentText ? ` ${argumentText}` : ""}"`;
  return {
    file: options.comspec ?? env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

function compareVersions(left: CodexCliVersion, right: CodexCliVersion): number {
  const numeric =
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch;
  if (numeric !== 0) return numeric;
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  return (left.prerelease ?? "").localeCompare(right.prerelease ?? "");
}

function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string {
  if (
    command.includes("\\") ||
    command.includes("/") ||
    /\.[A-Za-z0-9]+$/.test(command)
  ) {
    return command;
  }

  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(win32.delimiter)
    .filter(Boolean);
  for (const directory of (env.PATH ?? "").split(win32.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = win32.join(directory, `${command}${extension}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return command;
}

function assertSafeWindowsShellToken(value: string): void {
  if (/["&|<>^%!\r\n]/.test(value)) {
    throw new CodexCliUnavailableError(
      `Unsafe Windows command text cannot be passed through an npm shim: ${JSON.stringify(value)}`,
    );
  }
}

function quoteWindowsShellToken(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "ETIMEDOUT" || /ETIMEDOUT|timed out/i.test(error.message);
}

async function terminateTimedOutProbe(
  child: CodexProbeProcess,
  spec: CodexProcessSpec,
  closed: Promise<void>,
  isClosed: () => boolean,
  graceMs: number,
  runTerminationCommand = runProbeTerminationCommand,
): Promise<void> {
  if (isClosed()) return;
  if (spec.windowsVerbatimArguments === true) {
    if (child.pid === undefined) {
      throw new Error(
        "Cannot tree-terminate timed-out Windows Codex probe: child PID is unavailable.",
      );
    }
    const termination = await settlesWithin(
      runTerminationCommand("taskkill.exe", [
        "/PID",
        String(child.pid),
        "/T",
        "/F",
      ]),
      graceMs,
    );
    if (!termination) {
      throw new Error(
        `taskkill.exe did not finish while terminating timed-out Codex probe PID ${child.pid}`,
      );
    }
    if (termination.error) throw termination.error;
    return;
  }

  child.kill("SIGTERM");
  if (await resolvesWithin(closed, graceMs)) return;
  child.kill("SIGKILL");
}

function runProbeTerminationCommand(
  file: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = nodeSpawn(file, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    command.on("error", reject);
    command.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited with status ${String(code)}`));
    });
  });
}

async function resolvesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function settlesWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<{ error?: unknown } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(
      () => ({}),
      (error: unknown) => ({ error }),
    ),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}
