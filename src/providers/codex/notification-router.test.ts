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

  it("tombstones a completed turn synchronously and drops later notifications", () => {
    const router = new CodexNotificationRouter();
    const events: ProviderEvent[] = [];
    router.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: (event) => events.push(event) });
    router.bindTurn("tab-a", "turn-a");

    router.route({
      method: "turn/completed",
      params: {
        threadId: "thread-a",
        turn: {
          id: "turn-a", items: [], itemsView: { type: "full" }, status: "completed",
          error: null, startedAt: 1, completedAt: 2, durationMs: 1,
        },
      },
    } as never);
    expect(router.getOwnedTurnCount()).toBe(0);
    expect(router.getRetiredTurnCount()).toBe(1);
    const delivered = events.length;
    router.route(delta("thread-a", "turn-a", "late-item", "late"));
    expect(events).toHaveLength(delivered);
    expect(router.getBufferedCount("thread-a", "turn-a")).toBe(0);
  });

  it("retires an owned turn explicitly and cleans its lifecycle state", () => {
    const router = new CodexNotificationRouter();
    router.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: vi.fn() });
    router.route(delta("thread-a", "turn-a", "early", "early"));
    expect(router.getBufferedCount("thread-a", "turn-a")).toBe(1);
    expect(router.bindTurn("tab-a", "turn-a")).toBe(true);

    expect(router.retireTurn("tab-a", "turn-a")).toBe(true);

    expect(router.getBufferedCount("thread-a", "turn-a")).toBe(0);
    expect(router.getOwnedTurnCount()).toBe(0);
    expect(router.getRetiredTurnCount()).toBe(1);
    router.unregisterRuntime("tab-a");
    expect(router.getRetiredTurnCount()).toBe(0);
  });

  it("allows only the current owner to retire a turn", () => {
    const router = new CodexNotificationRouter();
    const owner = vi.fn();
    const peer = vi.fn();
    router.registerRuntime({ runtimeId: "owner", threadId: "shared-thread", onEvent: owner });
    router.registerRuntime({ runtimeId: "peer", threadId: "shared-thread", onEvent: peer });
    router.bindTurn("owner", "turn-a");

    expect(router.retireTurn("peer", "turn-a")).toBe(false);
    expect(router.getOwnedTurnCount()).toBe(1);
    expect(router.getRetiredTurnCount()).toBe(0);
    router.route(delta("shared-thread", "turn-a", "item", "owner only"));
    expect(owner).toHaveBeenCalledWith({ type: "text_delta", delta: "owner only", itemId: "item" });
    expect(peer).not.toHaveBeenCalled();
  });

  it("does not resurrect an immutable retired turn on a late duplicate bind", () => {
    const router = new CodexNotificationRouter();
    const events = vi.fn();
    router.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: events });
    expect(router.bindTurn("tab-a", "turn-a")).toBe(true);
    expect(router.retireTurn("tab-a", "turn-a")).toBe(true);

    expect(router.bindTurn("tab-a", "turn-a")).toBe(false);
    router.route(delta("thread-a", "turn-a", "late", "ignored"));

    expect(router.getOwnedTurnCount()).toBe(0);
    expect(router.getRetiredTurnCount()).toBe(1);
    expect(events).not.toHaveBeenCalled();
  });

  it("evicts oldest pre-bind events at per-item and total caps", () => {
    const perItemEvents: ProviderEvent[] = [];
    const perItem = new CodexNotificationRouter(undefined, {
      maxBufferedPerItem: 2,
      maxBufferedTotal: 10,
    });
    perItem.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: (event) => perItemEvents.push(event) });
    perItem.route(delta("thread-a", "turn-a", "item", "one"));
    perItem.route(delta("thread-a", "turn-a", "item", "two"));
    perItem.route(delta("thread-a", "turn-a", "item", "three"));
    perItem.bindTurn("tab-a", "turn-a");
    expect(perItemEvents).toEqual([
      { type: "text_delta", delta: "two", itemId: "item" },
      { type: "text_delta", delta: "three", itemId: "item" },
    ]);

    const totalEvents: ProviderEvent[] = [];
    const total = new CodexNotificationRouter(undefined, {
      maxBufferedPerItem: 10,
      maxBufferedTotal: 3,
    });
    total.registerRuntime({ runtimeId: "tab-b", threadId: "thread-b", onEvent: (event) => totalEvents.push(event) });
    for (const id of ["one", "two", "three", "four"]) {
      total.route(delta("thread-b", "turn-b", id, id));
    }
    total.bindTurn("tab-b", "turn-b");
    expect(totalEvents.map((event) => event.type === "text_delta" ? event.delta : null))
      .toEqual(["two", "three", "four"]);
  });

  it("expires orphan buffers using the injected clock and timer", () => {
    let now = 0;
    let expire: (() => void) | undefined;
    const router = new CodexNotificationRouter(undefined, {
      bufferTtlMs: 100,
      now: () => now,
      setTimer: (callback) => {
        expire = callback;
        return 1;
      },
      clearTimer: () => undefined,
    });
    const events = vi.fn();
    router.registerRuntime({ runtimeId: "tab-a", threadId: "thread-a", onEvent: events });
    router.route(delta("thread-a", "turn-a", "item", "secret output"));
    expect(router.getBufferedCount("thread-a", "turn-a")).toBe(1);

    now = 101;
    expire?.();
    router.bindTurn("tab-a", "turn-a");

    expect(router.getBufferedCount("thread-a", "turn-a")).toBe(0);
    expect(events).not.toHaveBeenCalled();
  });

  it("reports unknown notification methods once each up to a bounded cap", () => {
    const diagnostic = vi.fn();
    const router = new CodexNotificationRouter(undefined, {
      onUnknownNotification: diagnostic,
      maxUnknownDiagnostics: 2,
    });
    router.route({ method: "future/one", params: {} } as any);
    router.route({ method: "future/one", params: {} } as any);
    router.route({ method: "future/two", params: {} } as any);
    router.route({ method: "future/three", params: {} } as any);
    expect(diagnostic.mock.calls).toEqual([["future/one"], ["future/two"]]);
  });

  it("buffers capped startup warnings and delivers them once to the first runtime", () => {
    const router = new CodexNotificationRouter(undefined, { maxBufferedGlobal: 2 });
    router.route({ method: "configWarning", params: { summary: "Oldest" } } as any);
    router.route({ method: "configWarning", params: { summary: "Kept second" } } as any);
    router.route({ method: "configWarning", params: { summary: "Kept third" } } as any);
    expect(router.getGlobalBufferedCount()).toBe(2);

    const first = vi.fn();
    router.registerRuntime({ runtimeId: "first", threadId: "thread-1", onEvent: first });
    expect(first.mock.calls).toEqual([
      [{ type: "warning", message: "Kept second" }],
      [{ type: "warning", message: "Kept third" }],
    ]);
    expect(router.getGlobalBufferedCount()).toBe(0);

    const later = vi.fn();
    router.registerRuntime({ runtimeId: "later", threadId: "thread-2", onEvent: later });
    expect(later).not.toHaveBeenCalled();

    router.route({ method: "configWarning", params: { summary: "Live warning" } } as any);
    expect(first).toHaveBeenLastCalledWith({ type: "warning", message: "Live warning" });
    expect(later).toHaveBeenCalledWith({ type: "warning", message: "Live warning" });
  });

  it("clears startup warnings on dispose", () => {
    const router = new CodexNotificationRouter();
    router.route({ method: "configWarning", params: { summary: "Discard me" } } as any);
    expect(router.getGlobalBufferedCount()).toBe(1);
    router.dispose();
    expect(router.getGlobalBufferedCount()).toBe(0);
  });
});
