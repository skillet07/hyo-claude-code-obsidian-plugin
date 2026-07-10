import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type {
  ChatProvider,
  ProviderEvent,
  ProviderHistoryMessage,
  ProviderId,
  ProviderRuntime,
  ProviderRuntimeOptions,
  ProviderSessionSummary,
} from "../providers/types";

const providerMocks = vi.hoisted(() => ({
  providers: new Map<string, ChatProvider>(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

vi.mock("../providers/claude/provider", () => ({
  createClaudeProvider: ({ cliPath }: { cliPath: string }) => {
    const provider = providerMocks.providers.get(cliPath);
    if (!provider) throw new Error(`Missing fake provider for ${cliPath}`);
    return provider;
  },
}));

import { useSessionManager } from "./useSessionManager";
import { mapThreadHistory } from "../providers/codex/history-mapper";

class FakeRuntime implements ProviderRuntime {
  ready = false;
  started = false;
  cleanupCalls = 0;
  interruptCalls = 0;
  sent: (string | any[])[] = [];
  approvals: Array<{ requestId: string; behavior: string }> = [];
  questionResponses: Array<{ requestId: string; answers: Record<string, string> }> = [];

  constructor(
    readonly providerId: ProviderId,
    private readonly onEvent: (event: ProviderEvent) => void,
  ) {}

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

  respondApproval(requestId: string, behavior: "allow" | "allow_always" | "deny"): void {
    this.approvals.push({ requestId, behavior });
  }

  respondQuestion(
    requestId: string,
    _questions: any[],
    answers: Record<string, string>,
  ): void {
    this.questionResponses.push({ requestId, answers });
  }

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

  constructor(private readonly runtimeProviderId: ProviderId = "claude") {}

  createRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
    const runtime = new FakeRuntime(this.runtimeProviderId, options.onEvent);
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
    if (
      !String(message).includes("react-test-renderer is deprecated") &&
      !String(message).includes("[hyo] Provider error")
    ) {
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
  it("keeps an unspecified Claude error nonterminal and rejects an overlapping send", async () => {
    const provider = new FakeProvider("claude");
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");
    act(() => manager.sendMessage("hello"));

    act(() => provider.runtimes[0]!.emit({
      type: "error",
      message: "stderr diagnostic",
    }));

    expect(manager.activeGenerating).toBe(true);
    expect(manager.activeMessages.at(-1)?.streaming).toBe(true);
    expect(manager.activeMessages.at(-1)?.content).toBe("");
    expect(manager.sendMessage("overlap")).toBe(false);
    expect(provider.runtimes[0]!.sent).toEqual(["hello"]);
  });

  it("keeps a retrying Codex error visible but nonterminal until turn completion", async () => {
    const provider = new FakeProvider("codex");
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");
    act(() => manager.sendMessage("hello"));
    const runtime = provider.runtimes[0]!;

    act(() => runtime.emit({
      type: "error",
      message: "retrying transport",
      willRetry: true,
    }));

    expect(manager.activeGenerating).toBe(true);
    expect(manager.activeMessages.at(-1)?.streaming).toBe(true);
    expect(manager.activeMessages.at(-1)?.content).toContain("retrying transport");
    expect(manager.sendMessage("overlap")).toBe(false);

    act(() => runtime.emit({ type: "turn_completed", status: "completed" }));
    expect(manager.activeGenerating).toBe(false);
    expect(manager.activeMessages.at(-1)?.streaming).toBe(false);
  });

  it("renders one actionable error and finalizes a failed provider turn", async () => {
    const provider = new FakeProvider();
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");
    act(() => manager.sendMessage("hello"));
    const runtime = provider.runtimes[0]!;

    act(() => {
      runtime.emit({
        type: "error",
        message: "Codex connection failed. Send again to reconnect.",
        willRetry: false,
      });
      runtime.emit({
        type: "turn_completed",
        status: "failed",
        error: "Codex connection failed. Send again to reconnect.",
      });
    });

    const assistants = manager.activeMessages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toContain("Codex connection failed");
    expect(assistants[0]!.content.match(/Codex connection failed/g)).toHaveLength(1);
    expect(assistants[0]!.streaming).toBe(false);
    expect(manager.activeGenerating).toBe(false);
  });

  it("renders a terminal-only start failure instead of a blank assistant", async () => {
    const provider = new FakeProvider();
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");
    act(() => manager.sendMessage("hello"));

    act(() => provider.runtimes[0]!.emit({
      type: "turn_completed",
      status: "failed",
      error: "thread/start failed",
    }));

    expect(manager.activeMessages.at(-1)?.content).toContain("thread/start failed");
    expect(manager.activeMessages.at(-1)?.streaming).toBe(false);
    expect(manager.activeGenerating).toBe(false);
  });

  it("resolves matching controls, replaces question payloads, and ignores late answers", async () => {
    const provider = new FakeProvider();
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");
    act(() => manager.sendMessage("hello"));
    const runtime = provider.runtimes[0]!;

    act(() => runtime.emit({
      type: "approval_requested",
      requestId: "approval-1",
      toolName: "command",
    }));
    act(() => runtime.emit({
      type: "request_resolved",
      requestId: "approval-1",
      reason: "server",
    }));
    expect(manager.activeMessages.at(-1)?.permissionRequest?.resolved).toBe("denied");
    act(() => manager.sendPermissionResponse("approval-1", "allow"));
    expect(runtime.approvals).toEqual([]);

    act(() => runtime.emit({
      type: "question_requested",
      requestId: "question-1",
      questions: [{ id: "old", question: "Old question" }],
    }));
    act(() => runtime.emit({
      type: "question_requested",
      requestId: "question-2",
      questions: [{ id: "new", question: "New question", isSecret: true }],
    }));
    expect(manager.activeMessages.at(-1)?.askQuestion).toEqual({
      id: "question-2",
      questions: [{ id: "new", question: "New question", isSecret: true }],
      answers: {},
    });
    act(() => runtime.emit({
      type: "request_resolved",
      requestId: "question-2",
      reason: "server",
    }));
    expect(manager.activeMessages.at(-1)?.askQuestion).toBeNull();
    act(() => manager.sendQuestionAnswer("question-2", { new: "late" }));
    expect(runtime.questionResponses).toEqual([]);

    act(() => runtime.emit({
      type: "plan_review_requested",
      requestId: "plan-1",
      planContent: "Plan",
      allowedPrompts: [],
    }));
    act(() => runtime.emit({
      type: "request_resolved",
      requestId: "plan-1",
      reason: "server",
    }));
    expect(manager.activeMessages.at(-1)?.planReview?.resolved).toBe("rejected");
  });

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

  it("deduplicates concurrent opens of the same async history session", async () => {
    const provider = new FakeProvider();
    const pending = deferred<ProviderHistoryMessage[]>();
    const loadSession = vi.spyOn(provider, "loadSession")
      .mockImplementation(() => pending.promise);
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");
    const session: ProviderSessionSummary = {
      providerId: "claude",
      id: "session-race",
      title: "Race",
      date: new Date(),
    };

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = manager.openPastSession(session);
      second = manager.openPastSession(session);
    });
    expect(loadSession).toHaveBeenCalledTimes(1);
    pending.resolve([{ role: "assistant", content: "loaded" }]);
    await act(async () => Promise.all([first, second]));

    expect(manager.tabs.filter((tab) => tab.providerSessionId === "session-race"))
      .toHaveLength(1);
  });

  it("ignores history resolved by a provider generation that was replaced", async () => {
    const providerA = new FakeProvider();
    const providerB = new FakeProvider();
    const pending = deferred<ProviderHistoryMessage[]>();
    vi.spyOn(providerA, "loadSession").mockImplementation(() => pending.promise);
    providerMocks.providers.set("provider-a", providerA);
    providerMocks.providers.set("provider-b", providerB);
    await mount("provider-a");
    const session: ProviderSessionSummary = {
      providerId: "claude",
      id: "stale-session",
      title: "Stale",
      date: new Date(),
    };

    let opening!: Promise<void>;
    act(() => {
      opening = manager.openPastSession(session);
    });
    await act(async () => {
      renderer?.update(React.createElement(Harness, { cliPath: "provider-b" }));
    });
    pending.resolve([{ role: "assistant", content: "stale history" }]);
    await act(async () => opening);

    expect(manager.tabs.some((tab) => tab.providerSessionId === "stale-session"))
      .toBe(false);
  });

  it("shows failed Codex turn status when reopening mapped history", async () => {
    const provider = new FakeProvider();
    provider.history = mapThreadHistory({
      turns: [{
        id: "failed-turn",
        status: "failed",
        error: { message: "model unavailable" },
        itemsView: "full",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [],
      }],
    } as never);
    providerMocks.providers.set("provider-a", provider);
    await mount("provider-a");
    const session: ProviderSessionSummary = {
      providerId: "codex",
      id: "failed-session",
      title: "Failed session",
      date: new Date(),
    };

    await act(async () => manager.openPastSession(session));

    expect(manager.activeMessages.at(-1)?.content)
      .toContain("Turn failed: model unavailable");
    expect(manager.activeMessages.at(-1)?.streaming).toBe(false);
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
