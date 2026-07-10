import { describe, expect, it, vi } from "vitest";
import {
  CODEX_INSTALL_COMMAND,
  detectProviderCli,
  getProviderOnboarding,
  providerCliCandidates,
} from "./provider-onboarding";

describe("provider onboarding", () => {
  it("uses the official Codex installer and platform-specific terminal guidance", () => {
    expect(CODEX_INSTALL_COMMAND).toBe(
      "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    );
    expect(getProviderOnboarding("codex", "darwin")).toMatchObject({
      providerName: "Codex",
      terminalName: "Terminal",
      installCommand: CODEX_INSTALL_COMMAND,
    });
    expect(getProviderOnboarding("codex", "win32")).toMatchObject({
      openInstructions: expect.stringContaining("PowerShell"),
      installCommand: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    });
    expect(getProviderOnboarding("codex", "linux").pasteInstructions)
      .toContain("Ctrl+Shift+V");
    expect(getProviderOnboarding("claude", "linux").providerName).toBe("Claude");
  });

  it("includes custom and common paths on macOS, Linux, and Windows", () => {
    expect(providerCliCandidates("codex", "/custom/codex", "darwin", "/Users/me", ""))
      .toContain("/opt/homebrew/bin/codex");
    expect(providerCliCandidates("codex", "codex", "linux", "/home/me", ""))
      .toContain("/home/me/.local/bin/codex");
    expect(providerCliCandidates("codex", "codex", "win32", "C:\\Users\\me", "C:\\Users\\me\\AppData\\Roaming"))
      .toContain("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("prefers an existing custom path and falls back to PATH lookup", () => {
    const exists = vi.fn((candidate: string) => candidate === "/custom/codex");
    expect(detectProviderCli({
      providerId: "codex",
      configuredPath: "/custom/codex",
      platform: "linux",
      home: "/home/me",
      appData: "",
      exists,
      findOnPath: vi.fn(() => "/usr/bin/codex"),
    })).toBe("/custom/codex");

    expect(detectProviderCli({
      providerId: "codex",
      configuredPath: "codex",
      platform: "linux",
      home: "/home/me",
      appData: "",
      exists: vi.fn(() => false),
      findOnPath: vi.fn(() => "/usr/bin/codex"),
    })).toBe("/usr/bin/codex");
  });

  it("resolves an exact custom POSIX command without falling back to codex", () => {
    const findOnPath = vi.fn((binary: string) => binary === "codex-beta"
      ? "/opt/tools/codex-beta"
      : "/usr/bin/codex");
    expect(detectProviderCli({
      providerId: "codex",
      configuredPath: "codex-beta",
      platform: "linux",
      home: "/home/me",
      appData: "",
      exists: vi.fn(() => false),
      findOnPath,
    })).toBe("/opt/tools/codex-beta");
    expect(findOnPath).toHaveBeenCalledWith("codex-beta");
    expect(findOnPath).not.toHaveBeenCalledWith("codex");
  });

  it("resolves an exact custom Windows command and exact custom file path", () => {
    const findOnPath = vi.fn((binary: string) => binary === "codex-preview.cmd"
      ? "C:\\Tools\\codex-preview.cmd"
      : "");
    expect(detectProviderCli({
      providerId: "codex",
      configuredPath: "codex-preview.cmd",
      platform: "win32",
      home: "C:\\Users\\me",
      appData: "C:\\Users\\me\\AppData\\Roaming",
      exists: vi.fn(() => false),
      findOnPath,
    })).toBe("C:\\Tools\\codex-preview.cmd");
    expect(findOnPath).toHaveBeenCalledWith("codex-preview.cmd");

    expect(detectProviderCli({
      providerId: "codex",
      configuredPath: "C:\\Custom\\codex.exe",
      platform: "win32",
      home: "C:\\Users\\me",
      appData: "",
      exists: vi.fn((candidate) => candidate === "C:\\Custom\\codex.exe"),
      findOnPath: vi.fn(() => ""),
    })).toBe("C:\\Custom\\codex.exe");
  });
});
