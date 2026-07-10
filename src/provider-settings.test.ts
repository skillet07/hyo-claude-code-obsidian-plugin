import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  sanitizeSettingsForPersistence,
  updateCodexDefaultModel,
} from "./provider-settings";

describe("provider settings", () => {
  it("keeps new installs on Claude while providing safe Codex defaults", () => {
    expect(DEFAULT_SETTINGS.defaultProvider).toBe("claude");
    expect(DEFAULT_SETTINGS.providerSettings.claude).toEqual({
      cliPath: "/usr/local/bin/claude",
      model: "claude-sonnet-4-5-20250929",
      permissionMode: "manual",
      defaultAgent: "",
      maxOutputTokens: 64000,
    });
    expect(DEFAULT_SETTINGS.providerSettings.codex).toEqual({
      cliPath: "codex",
      model: "",
      reasoningEffort: "",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      networkAccess: false,
    });
  });

  it("migrates legacy flat Claude settings without changing global settings", () => {
    const migrated = migrateSettings({
      cliPath: "/custom/claude",
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      defaultAgent: "reviewer",
      maxOutputTokens: 32000,
      workingDirectory: "/vault/project",
      elevenLabsApiKey: "voice-key",
      voiceId: "voice",
    });

    expect(migrated.defaultProvider).toBe("claude");
    expect(migrated.providerSettings.claude).toEqual({
      cliPath: "/custom/claude",
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      defaultAgent: "reviewer",
      maxOutputTokens: 32000,
    });
    expect(migrated.workingDirectory).toBe("/vault/project");
    expect(migrated.elevenLabsApiKey).toBe("voice-key");
    expect(migrated.voiceId).toBe("voice");
  });

  it("preserves nested provider settings and normalizes stale Claude values", () => {
    const migrated = migrateSettings({
      defaultProvider: "codex",
      providerSettings: {
        claude: {
          cliPath: "claude",
          model: "claude-sonnet-5[1m]",
          permissionMode: "default",
          defaultAgent: "",
          maxOutputTokens: 12000,
        },
        codex: {
          cliPath: "/custom/codex",
          model: "gpt-5.2-codex",
          reasoningEffort: "high",
          approvalPolicy: "never",
          sandboxMode: "read-only",
          networkAccess: true,
        },
      },
    });

    expect(migrated.defaultProvider).toBe("codex");
    expect(migrated.providerSettings.claude.model).toBe("claude-sonnet-5");
    expect(migrated.providerSettings.claude.permissionMode).toBe("manual");
    expect(migrated.providerSettings.codex).toEqual({
      cliPath: "/custom/codex",
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
      approvalPolicy: "never",
      sandboxMode: "read-only",
      networkAccess: true,
    });
  });

  it("never persists provider credentials or unknown token fields", () => {
    const persisted = sanitizeSettingsForPersistence({
      ...migrateSettings({}),
      apiKey: "secret",
      accessToken: "secret",
      providerSettings: {
        ...migrateSettings({}).providerSettings,
        codex: {
          ...migrateSettings({}).providerSettings.codex,
          apiKey: "secret",
          token: "secret",
        },
      },
    });

    expect(JSON.stringify(persisted)).not.toContain("secret");
    expect(persisted).toEqual(migrateSettings({}));
  });

  it("clears saved reasoning effort when settings change the Codex model", () => {
    const settings = migrateSettings({
      providerSettings: {
        codex: { model: "model-a", reasoningEffort: "high" },
      },
    });

    updateCodexDefaultModel(settings, "model-b");

    expect(settings.providerSettings.codex.model).toBe("model-b");
    expect(settings.providerSettings.codex.reasoningEffort).toBe("");
  });
});
