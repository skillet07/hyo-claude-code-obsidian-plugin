import { win32 } from "node:path";
import type { ProviderId } from "./providers/types";

export const CODEX_INSTALL_COMMAND =
  "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
export const CODEX_WINDOWS_INSTALL_COMMAND =
  'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"';

export function codexInstallCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? CODEX_WINDOWS_INSTALL_COMMAND
    : CODEX_INSTALL_COMMAND;
}

export interface ProviderOnboarding {
  providerName: string;
  terminalName: string;
  openInstructions: string;
  pasteInstructions: string;
  installCommand: string;
  installUrl: string;
}

export function getProviderOnboarding(
  providerId: ProviderId,
  platform: NodeJS.Platform = process.platform,
): ProviderOnboarding {
  const isWindows = platform === "win32";
  const providerName = providerId === "codex" ? "Codex" : "Claude";
  return {
    providerName,
    terminalName: isWindows ? "PowerShell" : "Terminal",
    openInstructions: platform === "darwin"
      ? "Press Cmd+Space, type 'Terminal', and press Enter"
      : isWindows
      ? "Press the Windows key, type 'PowerShell', and press Enter"
      : "Open your terminal application",
    pasteInstructions: isWindows
      ? "Right-click in the PowerShell window to paste"
      : platform === "darwin"
      ? "Press Cmd+V to paste"
      : "Press Ctrl+Shift+V or right-click to paste",
    installCommand: providerId === "codex"
      ? codexInstallCommand(platform)
      : isWindows
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash",
    installUrl: providerId === "codex"
      ? "https://developers.openai.com/codex/cli"
      : "https://docs.anthropic.com/en/docs/claude-code/setup",
  };
}

export function providerCliCandidates(
  providerId: ProviderId,
  configuredPath: string,
  platform: NodeJS.Platform,
  home: string,
  appData: string,
): string[] {
  const binary = providerId === "codex" ? "codex" : "claude";
  const custom = configuredPath && isPathLike(configuredPath)
    ? [configuredPath]
    : [];
  if (platform === "win32") {
    const npmRoot = appData || win32.join(home, "AppData", "Roaming");
    return [...custom, win32.join(npmRoot, "npm", `${binary}.cmd`)];
  }
  return [
    ...custom,
    `${home}/.local/bin/${binary}`,
    `${home}/.npm-global/bin/${binary}`,
    `/opt/homebrew/bin/${binary}`,
    `/usr/local/bin/${binary}`,
    `/usr/bin/${binary}`,
  ];
}

export interface DetectProviderCliOptions {
  providerId: ProviderId;
  configuredPath: string;
  platform: NodeJS.Platform;
  home: string;
  appData: string;
  exists(path: string): boolean;
  findOnPath(binary: string): string;
}

export function detectProviderCli(options: DetectProviderCliOptions): string {
  const binary = options.providerId === "codex" ? "codex" : "claude";
  const configured = options.configuredPath.trim();
  const standardCandidates = providerCliCandidates(
    options.providerId,
    binary,
    options.platform,
    options.home,
    options.appData,
  );
  const configuredIsStandard = configured === binary ||
    configured === `/usr/local/bin/${binary}` ||
    standardCandidates.includes(configured);
  if (configured && !configuredIsStandard) {
    return isPathLike(configured)
      ? options.exists(configured) ? configured : ""
      : options.findOnPath(configured).trim();
  }
  for (const candidate of standardCandidates) {
    if (options.exists(candidate)) return candidate;
  }
  return options.findOnPath(binary).trim();
}

function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".");
}
