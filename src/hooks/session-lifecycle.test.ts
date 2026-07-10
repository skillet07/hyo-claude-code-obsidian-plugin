import { describe, expect, it } from "vitest";
import { SessionLifecycle } from "./session-lifecycle";

interface FakeRuntime {
  cleanup(): void;
}

function runtime(): FakeRuntime {
  return { cleanup() {} };
}

describe("SessionLifecycle", () => {
  it("does not let a stale close release a replacement runtime", () => {
    const lifecycle = new SessionLifecycle<FakeRuntime>();
    let oldCleanupCalls = 0;
    const oldRuntime = { cleanup: () => oldCleanupCalls++ };
    const oldLease = lifecycle.attachRuntime("tab-1", oldRuntime);

    const replacement = runtime();
    const replacementLease = lifecycle.attachRuntime("tab-1", replacement);

    expect(oldCleanupCalls).toBe(1);
    expect(lifecycle.releaseRuntime(oldLease)).toBe(false);
    expect(lifecycle.getRuntime("tab-1")).toBe(replacement);
    expect(lifecycle.releaseRuntime(replacementLease)).toBe(true);
    expect(lifecycle.getRuntime("tab-1")).toBeUndefined();
  });

  it("rejects overlapping turns synchronously for the same tab", () => {
    const lifecycle = new SessionLifecycle<FakeRuntime>();

    expect(lifecycle.beginTurn("tab-1")).toBe(true);
    expect(lifecycle.beginTurn("tab-1")).toBe(false);
    expect(lifecycle.beginTurn("tab-2")).toBe(true);

    lifecycle.finishTurn("tab-1");
    expect(lifecycle.beginTurn("tab-1")).toBe(true);
  });

  it("detaches runtime ownership before intentional cleanup callbacks run", () => {
    const lifecycle = new SessionLifecycle<FakeRuntime>();
    let lease: ReturnType<typeof lifecycle.attachRuntime>;
    let ownedDuringCleanup = true;
    const oldRuntime = {
      cleanup() {
        ownedDuringCleanup = lifecycle.ownsRuntime(lease);
      },
    };
    lease = lifecycle.attachRuntime("tab-1", oldRuntime);

    lifecycle.cleanupRuntime("tab-1");

    expect(ownedDuringCleanup).toBe(false);
    expect(lifecycle.getRuntime("tab-1")).toBeUndefined();
  });
});
