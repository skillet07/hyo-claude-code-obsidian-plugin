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
const originalDocument = (globalThis as any).document;
const originalInnerHeight = (globalThis as any).innerHeight;
const originalInnerWidth = (globalThis as any).innerWidth;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  if (originalDocument === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = originalDocument;
  if (originalInnerHeight === undefined) delete (globalThis as any).innerHeight;
  else (globalThis as any).innerHeight = originalInnerHeight;
  if (originalInnerWidth === undefined) delete (globalThis as any).innerWidth;
  else (globalThis as any).innerWidth = originalInnerWidth;
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

  it("positions the Codex context popup above the bar and dismisses it contextually", async () => {
    let outsideClick: ((event: { target: unknown }) => void) | undefined;
    const addEventListener = vi.fn((event: string, listener: typeof outsideClick) => {
      if (event === "mousedown") outsideClick = listener;
    });
    const removeEventListener = vi.fn();
    (globalThis as any).document = { addEventListener, removeEventListener };
    (globalThis as any).innerHeight = 900;
    (globalThis as any).innerWidth = 1000;
    const onCompact = vi.fn();
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
        inputTokens={10_000}
        contextWindow={100_000}
        voiceMode={false}
        hasVoiceApiKey={false}
        onModelChange={vi.fn()}
        onPermissionModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onVoiceModeToggle={vi.fn()}
        onCompact={onCompact}
        onReasoningEffortChange={vi.fn()}
        onApprovalPolicyChange={vi.fn()}
        onSandboxModeChange={vi.fn()}
        onNetworkAccessChange={vi.fn()}
      />, {
        createNodeMock: (element) =>
          (element as React.ReactElement<{ className?: string }>).props.className === "hyo-status-bar"
          ? {
              getBoundingClientRect: () => ({ top: 700, left: 850 }),
              contains: () => false,
            }
          : {},
      });
      await Promise.resolve();
    });

    const toggle = () => renderer!.root
      .findByProps({ className: "hyo-context-ring-btn" }).props.onClick();
    act(toggle);
    expect(renderer!.root.findByProps({ className: "hyo-context-popup" }).props.style.bottom)
      .toBe(206);
    expect(renderer!.root.findByProps({ className: "hyo-context-popup" }).props.style.left)
      .toBe(692);
    expect(renderer!.root.findAllByProps({ className: "hyo-usage-value" })
      .map((node) => node.children.join("")))
      .toContain("10K / 100K");
    expect(addEventListener).toHaveBeenCalledWith("mousedown", expect.any(Function));

    act(() => outsideClick?.({ target: {} }));
    expect(renderer!.root.findAllByProps({ className: "hyo-context-popup" })).toHaveLength(0);

    act(toggle);
    act(() => renderer!.root.findByProps({ className: "hyo-compact-now-btn" }).props.onClick());
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAllByProps({ className: "hyo-context-popup" })).toHaveLength(0);

    act(toggle);
    act(toggle);
    expect(renderer!.root.findAllByProps({ className: "hyo-context-popup" })).toHaveLength(0);
  });
});
