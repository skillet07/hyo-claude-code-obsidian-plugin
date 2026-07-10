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
    expect(getProviderOnboarding("codex", "win32").openInstructions).toContain(
      "PowerShell",
    );
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
});
