import type {
  ProviderApprovalPolicy,
  ProviderId,
  ProviderSandboxMode,
} from "./providers/types";

export interface ClaudeProviderSettings {
  cliPath: string;
  model: string;
  permissionMode: string;
  defaultAgent: string;
  maxOutputTokens: number;
}

export interface CodexProviderSettings {
  cliPath: string;
  model: string;
  reasoningEffort: string;
  approvalPolicy: ProviderApprovalPolicy;
  sandboxMode: ProviderSandboxMode;
  networkAccess: boolean;
}

export interface HyoSettings {
  defaultProvider: ProviderId;
  providerSettings: {
    claude: ClaudeProviderSettings;
    codex: CodexProviderSettings;
  };
  workingDirectory: string;
  autoGenerateTitles: boolean;
  elevenLabsApiKey: string;
  voiceId: string;
  voiceName: string;
  voicePlaybackSpeed: number;
  voiceAutoSpeak: boolean;
}

export const DEFAULT_SETTINGS: HyoSettings = {
  defaultProvider: "claude",
  providerSettings: {
    claude: {
      cliPath: "claude",
      model: "claude-sonnet-4-5-20250929",
      permissionMode: "manual",
      defaultAgent: "",
      maxOutputTokens: 64000,
    },
    codex: {
      cliPath: "codex",
      model: "",
      reasoningEffort: "",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      networkAccess: false,
    },
  },
  workingDirectory: "",
  autoGenerateTitles: true,
  elevenLabsApiKey: "",
  voiceId: "",
  voiceName: "",
  voicePlaybackSpeed: 1.25,
  voiceAutoSpeak: true,
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? value as UnknownRecord
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function approvalPolicy(value: unknown): ProviderApprovalPolicy {
  return value === "untrusted" || value === "on-request" || value === "never"
    ? value
    : DEFAULT_SETTINGS.providerSettings.codex.approvalPolicy;
}

function sandboxMode(value: unknown): ProviderSandboxMode {
  return value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
    ? value
    : DEFAULT_SETTINGS.providerSettings.codex.sandboxMode;
}

function normalizeClaudeModel(model: string): string {
  if (["opus", "sonnet", "haiku"].includes(model)) {
    return DEFAULT_SETTINGS.providerSettings.claude.model;
  }
  return model === "claude-sonnet-5[1m]" ? "claude-sonnet-5" : model;
}

export function migrateSettings(value: unknown): HyoSettings {
  const source = record(value);
  const providers = record(source.providerSettings);
  const nestedClaude = record(providers.claude);
  const nestedCodex = record(providers.codex);
  const claudeModel = normalizeClaudeModel(stringValue(
    nestedClaude.model,
    stringValue(source.model, DEFAULT_SETTINGS.providerSettings.claude.model),
  ));
  const legacyPermission = stringValue(
    nestedClaude.permissionMode,
    stringValue(source.permissionMode, DEFAULT_SETTINGS.providerSettings.claude.permissionMode),
  );

  return {
    defaultProvider: source.defaultProvider === "codex" ? "codex" : "claude",
    providerSettings: {
      claude: {
        cliPath: stringValue(
          nestedClaude.cliPath,
          stringValue(source.cliPath, DEFAULT_SETTINGS.providerSettings.claude.cliPath),
        ),
        model: claudeModel,
        permissionMode: legacyPermission === "default" ? "manual" : legacyPermission,
        defaultAgent: stringValue(
          nestedClaude.defaultAgent,
          stringValue(source.defaultAgent, DEFAULT_SETTINGS.providerSettings.claude.defaultAgent),
        ),
        maxOutputTokens: numberValue(
          nestedClaude.maxOutputTokens,
          numberValue(source.maxOutputTokens, DEFAULT_SETTINGS.providerSettings.claude.maxOutputTokens),
        ),
      },
      codex: {
        cliPath: stringValue(
          nestedCodex.cliPath,
          DEFAULT_SETTINGS.providerSettings.codex.cliPath,
        ),
        model: stringValue(
          nestedCodex.model,
          DEFAULT_SETTINGS.providerSettings.codex.model,
        ),
        reasoningEffort: stringValue(
          nestedCodex.reasoningEffort,
          DEFAULT_SETTINGS.providerSettings.codex.reasoningEffort,
        ),
        approvalPolicy: approvalPolicy(nestedCodex.approvalPolicy),
        sandboxMode: sandboxMode(nestedCodex.sandboxMode),
        networkAccess: booleanValue(
          nestedCodex.networkAccess,
          DEFAULT_SETTINGS.providerSettings.codex.networkAccess,
        ),
      },
    },
    workingDirectory: stringValue(source.workingDirectory, DEFAULT_SETTINGS.workingDirectory),
    autoGenerateTitles: booleanValue(source.autoGenerateTitles, DEFAULT_SETTINGS.autoGenerateTitles),
    elevenLabsApiKey: stringValue(source.elevenLabsApiKey, DEFAULT_SETTINGS.elevenLabsApiKey),
    voiceId: stringValue(source.voiceId, DEFAULT_SETTINGS.voiceId),
    voiceName: stringValue(source.voiceName, DEFAULT_SETTINGS.voiceName),
    voicePlaybackSpeed: numberValue(source.voicePlaybackSpeed, DEFAULT_SETTINGS.voicePlaybackSpeed),
    voiceAutoSpeak: booleanValue(source.voiceAutoSpeak, DEFAULT_SETTINGS.voiceAutoSpeak),
  };
}

export function sanitizeSettingsForPersistence(value: unknown): HyoSettings {
  return migrateSettings(value);
}

export function updateCodexDefaultModel(
  settings: HyoSettings,
  model: string,
): void {
  settings.providerSettings.codex.model = model.trim();
  settings.providerSettings.codex.reasoningEffort = "";
}
