import { spawnSync } from "node:child_process";
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
  runVersion?: (
    spec: CodexProcessSpec,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => string;
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

export interface CodexProcessSpecOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  comspec?: string;
}

export const DEFAULT_CODEX_VERSION_TIMEOUT_MS = 3_000;

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

export function assertCodexCliVersion(
  options: AssertCodexCliVersionOptions = {},
): CodexCliVersion {
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
    ((commandSpec: CodexProcessSpec, commandEnv: NodeJS.ProcessEnv) => {
      const result = spawnSync(commandSpec.file, commandSpec.args, {
        encoding: "utf8",
        env: commandEnv,
        timeout: timeoutMs,
        windowsHide: true,
        windowsVerbatimArguments: commandSpec.windowsVerbatimArguments,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw Object.assign(
          new Error(
            result.stderr.trim() ||
              `Codex CLI version probe exited with status ${String(result.status)}`,
          ),
          {
            status: result.status,
            signal: result.signal,
            stderr: result.stderr,
          },
        );
      }
      return result.stdout;
    });

  let output: string;
  try {
    output = runVersion(spec, env, timeoutMs);
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
      `Found ${version.raw}, but Hyo requires ${MINIMUM_CODEX_CLI_VERSION} or newer. Please update Codex CLI and restart Obsidian.`,
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
