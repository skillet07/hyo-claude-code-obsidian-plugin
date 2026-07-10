import { describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "../types";
import { CodexNotificationRouter } from "./notification-router";

const delta = (threadId: string, turnId: string, itemId: string, text: string) => ({
  method: "item/agentMessage/delta" as const,
  params: { threadId, turnId, itemId, delta: text },
});

describe("CodexNotificationRouter", () => {
  it("routes two interleaved threads and turns without cross-thread leakage", () => {
    const router = new CodexNotificationRouter();
    const first: ProviderEvent[] = [];
    const second: ProviderEvent[] = [];
    router.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: (event) => first.push(event) });
    router.registerRuntime({ runtimeId: "tab-b", threadId: "thread-b", onEvent: (event) => second.push(event) });
    router.bindTurn("tab-a", "turn-a");
    router.bindTurn("tab-b", "turn-b");

    router.route(delta("thread-b", "turn-b", "item-b", "B1"));
    router.route(delta("thread-a", "turn-a", "item-a", "A1"));
    router.route(delta("thread-b", "turn-b", "item-b", "B2"));

    expect(first).toEqual([{ type: "text_delta", delta: "A1", itemId: "item-a" }]);
    expect(second).toEqual([
      { type: "text_delta", delta: "B1", itemId: "item-b" },
      { type: "text_delta", delta: "B2", itemId: "item-b" },
    ]);
  });

  it("buffers item notifications before turn/start response binding and flushes in wire order", () => {
    const router = new CodexNotificationRouter();
    const events: ProviderEvent[] = [];
    router.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: (event) => events.push(event) });

    router.route(delta("thread-a", "turn-early", "item-2", "second item first"));
    router.route(delta("thread-a", "turn-early", "item-1", "first item second"));
    expect(events).toEqual([]);
    expect(router.getBufferedCount("thread-a", "turn-early")).toBe(2);

    router.bindTurn("tab-a", "turn-early");

    expect(events).toEqual([
      { type: "text_delta", delta: "second item first", itemId: "item-2" },
      { type: "text_delta", delta: "first item second", itemId: "item-1" },
    ]);
    expect(router.getBufferedCount("thread-a", "turn-early")).toBe(0);
  });

  it("keys ownership by thread and turn even when turn ids are identical", () => {
    const router = new CodexNotificationRouter();
    const first = vi.fn();
    const second = vi.fn();
    router.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: first });
    router.registerRuntime({ runtimeId: "tab-b", threadId: "thread-b", onEvent: second });
    router.bindTurn("tab-a", "same-turn");
    router.bindTurn("tab-b", "same-turn");

    router.route(delta("thread-a", "same-turn", "same-item", "A"));
    router.route(delta("thread-b", "same-turn", "same-item", "B"));

    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith({ type: "text_delta", delta: "A", itemId: "same-item" });
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith({ type: "text_delta", delta: "B", itemId: "same-item" });
  });

  it("removes runtime ownership and does not leak later events to another tab", () => {
    const router = new CodexNotificationRouter();
    const first = vi.fn();
    const second = vi.fn();
    router.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: first });
    router.registerRuntime({ runtimeId: "tab-b", threadId: "thread-b", onEvent: second });
    router.bindTurn("tab-a", "turn-a");
    router.unregisterRuntime("tab-a");

    router.route(delta("thread-a", "turn-a", "item-a", "late"));

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(router.getBufferedCount("thread-a", "turn-a")).toBe(0);
  });
});
