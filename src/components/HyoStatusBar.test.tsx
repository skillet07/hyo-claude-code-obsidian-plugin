import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";

vi.mock("../hooks/useUsage", () => ({
  useUsage: vi.fn(() => ({
    usage: null,
    sessionPct: 0,
    weeklyPct: 0,
    sessionPacePct: null,
    weeklyPacePct: null,
    lastUpdated: null,
    stale: false,
    refresh: vi.fn(),
  })),
}));
vi.mock("../hooks/useAgents", () => ({
  useAgents: vi.fn(() => [{ name: "", description: "", color: "gray" }] ),
}));

import { useUsage } from "../hooks/useUsage";
import { useAgents } from "../hooks/useAgents";
import { HyoStatusBar } from "./HyoStatusBar";
import type { ChatProvider } from "../providers/types";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
});

describe("HyoStatusBar provider boundaries", () => {
  it("does not mount Claude usage or agent hooks for a Codex tab", async () => {
    const provider = {
      id: "codex",
      capabilities: {
        approvals: true, questions: true, planReview: false, agents: true,
        sessionHistory: true, sessionRename: true, compaction: true, recovery: false,
        tokenUsage: true, models: true, skills: true, rateLimits: true, auth: true,
      },
      createRuntime: vi.fn(), listSessions: vi.fn(async () => []),
      loadSession: vi.fn(async () => []), renameSession: vi.fn(async () => undefined),
      recoverSession: vi.fn(async () => ({ success: false, linesRemoved: 0, capturedUserText: null })),
      cleanup: vi.fn(),
    } as ChatProvider;
    await act(async () => {
      renderer = create(<HyoStatusBar
        provider={provider}
        providerOptions={{ model: "", approvalPolicy: "on-request", sandboxMode: "workspace-write", networkAccess: false }}
        model=""
        permissionMode="manual"
        agent=""
        inputTokens={0}
        voiceMode={false}
        hasVoiceApiKey={false}
        onModelChange={vi.fn()}
        onPermissionModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onVoiceModeToggle={vi.fn()}
        onCompact={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onApprovalPolicyChange={vi.fn()}
        onSandboxModeChange={vi.fn()}
        onNetworkAccessChange={vi.fn()}
      />);
      await Promise.resolve();
    });

    expect(useUsage).not.toHaveBeenCalled();
    expect(useAgents).not.toHaveBeenCalled();
  });
});
