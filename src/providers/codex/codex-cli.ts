import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";

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
  runVersion?: (command: string, env: NodeJS.ProcessEnv) => string;
}

export class CodexCliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCliUnavailableError";
  }
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

export function assertCodexCliVersion(
  options: AssertCodexCliVersionOptions = {},
): CodexCliVersion {
  const command = options.command ?? "codex";
  const env = options.env ?? process.env;
  const runVersion =
    options.runVersion ??
    ((binary: string, commandEnv: NodeJS.ProcessEnv) =>
      execFileSync(binary, ["--version"], {
        encoding: "utf8",
        env: commandEnv,
        windowsHide: true,
      }));

  let output: string;
  try {
    output = runVersion(command, env);
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new CodexCliUnavailableError(
      `Codex CLI was not found${detail}. Install or update Codex CLI and ensure "codex" is available on PATH.`,
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
): string {
  const candidates = [
    home ? `${home}/.local/bin` : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...currentPath.split(delimiter),
  ].filter(Boolean);
  return [...new Set(candidates)].join(delimiter);
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
