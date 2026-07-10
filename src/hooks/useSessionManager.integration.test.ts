import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type {
  ChatProvider,
  ProviderEvent,
  ProviderHistoryMessage,
  ProviderRuntime,
  ProviderRuntimeOptions,
  ProviderSessionSummary,
} from "../providers/types";

const providerMocks = vi.hoisted(() => ({
  providers: new Map<string, ChatProvider>(),
}));

vi.mock("../providers/claude/provider", () => ({
  createClaudeProvider: ({ cliPath }: { cliPath: string }) => {
    const provider = providerMocks.providers.get(cliPath);
    if (!provider) throw new Error(`Missing fake provider for ${cliPath}`);
    return provider;
  },
}));

import { useSessionManager } from "./useSessionManager";

class FakeRuntime implements ProviderRuntime {
  readonly providerId = "claude" as const;
  ready = false;
  started = false;
  cleanupCalls = 0;
  interruptCalls = 0;
  sent: (string | any[])[] = [];

  constructor(private readonly onEvent: (event: ProviderEvent) => void) {}

  start(): void {
    this.started = true;
  }

  isRunning(): boolean {
    return this.started && this.cleanupCalls === 0;
  }

  send(content: string | any[]): void {
    this.sent.push(content);
  }

  interrupt(): void {
    this.interruptCalls++;
  }

  respondApproval(): void {}
  respondQuestion(): void {}

  compact(): void {
    this.send("/compact");
  }

  cleanup(): void {
    if (this.cleanupCalls === 0) this.cleanupCalls++;
  }

  emit(event: ProviderEvent): void {
    this.onEvent(event);
  }
}

class FakeProvider implements ChatProvider {
  readonly id = "claude" as const;
  readonly capabilities = {
    approvals: true,
    questions: true,
    planReview: true,
    agents: true,
    sessionHistory: true,
    sessionRename: true,
    compaction: true,
    recovery: true,
    tokenUsage: true,
    models: false,
    skills: false,
    rateLimits: false,
    auth: false,
  };
  readonly runtimes: FakeRuntime[] = [];
  sessions: ProviderSessionSummary[] = [];
  history: ProviderHistoryMessage[] = [];
  cleanupCalls = 0;

  createRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
    const runtime = new FakeRuntime(options.onEvent);
    this.runtimes.push(runtime);
    return runtime;
  }

  async listSessions() {
    return this.sessions;
  }

  async loadSession() {
    return this.history;
  }

  async renameSession(): Promise<void> {}

  async recoverSession() {
    return { success: false, linesRemoved: 0, capturedUserText: null };
  }

  cleanup(): void {
    this.cleanupCalls++;
    for (const runtime of this.runtimes) runtime.cleanup();
  }
}

let renderer: ReactTestRenderer | null = null;
let manager: ReturnType<typeof useSessionManager>;

function Harness({ cliPath }: { cliPath: string }) {
  manager = useSessionManager({
    cliPath,
    cwd: "/tmp/vault",
    model: "sonnet",
    permissionMode: "default",
    defaultAgent: "",
  });
  return null;
}

async function mount(cliPath: string): Promise<void> {
  await act(async () => {
    renderer = create(React.createElement(Harness, { cliPath }));
  });
}

beforeEach(() => {
  providerMocks.providers.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, "error").mockImplementation((message) => {
    if (!String(message).includes("react-test-renderer is deprecated")) {
      throw new Error(String(message));
    }
  });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.restoreAllMocks();
});

describe("useSessionManager lifecycle integration", () => {
  it("awaits asynchronous session listing and history loading", async () => {
    const provider = new FakeProvider();
    provider.sessions = [{
      providerId: "claude",
      id: "session-1",
      title: "Past session",
      date: new Date("2026-07-10T00:00:00Z"),
    }];
    provider.history = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");

    await act(async () => {
      await manager.refreshPastSessions();
    });
    expect(manager.pastSessions).toEqual(provider.sessions);

    await act(async () => {
      await manager.openPastSession(provider.sessions[0]!);
    });
    expect(manager.activeMessages.map((message) => message.content)).toEqual([
      "hello",
      "hi",
    ]);
  });

  it("rejects an overlapping send and reports acceptance explicitly", async () => {
    const provider = new FakeProvider();
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");

    let firstAccepted: boolean | undefined;
    let secondAccepted: boolean | undefined;
    act(() => {
      firstAccepted = manager.sendMessage("first");
      secondAccepted = manager.sendMessage("second");
    });

    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(false);
    expect(provider.runtimes).toHaveLength(1);
    expect(provider.runtimes[0].sent).toEqual(["first"]);
    expect(manager.activeMessages.filter((message) => message.role === "user"))
      .toHaveLength(1);
  });

  it("stops by retiring the runtime, accepts the next send, and ignores old callbacks", async () => {
    const provider = new FakeProvider();
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");

    act(() => {
      manager.sendMessage("first");
    });
    const oldRuntime = provider.runtimes[0];

    act(() => manager.stopGeneration());

    expect(oldRuntime.interruptCalls).toBe(1);
    expect(oldRuntime.cleanupCalls).toBe(1);

    let accepted: boolean | undefined;
    act(() => {
      accepted = manager.sendMessage("after stop");
    });
    expect(accepted).toBe(true);
    expect(provider.runtimes).toHaveLength(2);

    act(() => {
      oldRuntime.emit({ type: "text_delta", delta: "stale" });
      oldRuntime.emit({ type: "turn_completed" });
      oldRuntime.emit({ type: "closed", exitCode: 1 });
    });

    expect(manager.activeGenerating).toBe(true);
    expect(manager.activeMessages.at(-1)?.content).toBe("");
  });

  it("cleans the old provider and runtime when the provider instance changes", async () => {
    const providerA = new FakeProvider();
    const providerB = new FakeProvider();
    providerMocks.providers.set("provider-a", providerA);
    providerMocks.providers.set("provider-b", providerB);
    await mount("provider-a");

    act(() => {
      manager.sendMessage("first");
    });
    const oldRuntime = providerA.runtimes[0];

    await act(async () => {
      renderer?.update(React.createElement(Harness, { cliPath: "provider-b" }));
    });

    expect(providerA.cleanupCalls).toBe(1);
    expect(oldRuntime.cleanupCalls).toBe(1);
    expect(manager.activeGenerating).toBe(false);
    expect(manager.activeMessages.at(-1)?.streaming).toBe(false);

    let accepted: boolean | undefined;
    act(() => {
      accepted = manager.sendMessage("new provider");
    });
    expect(accepted).toBe(true);
    expect(providerB.runtimes).toHaveLength(1);
  });
});
