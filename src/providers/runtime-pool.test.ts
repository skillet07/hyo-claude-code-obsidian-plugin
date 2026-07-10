import { describe, expect, it } from "vitest";
import { RuntimePool } from "./runtime-pool";

describe("RuntimePool", () => {
  it("unregisters a runtime when its cleanup handle runs and cleans it once", () => {
    const pool = new RuntimePool<object>();
    const runtime = {};
    let cleanupCalls = 0;
    const handle = pool.register(runtime, () => cleanupCalls++);

    handle.cleanup();
    handle.cleanup();
    pool.cleanupAll();

    expect(cleanupCalls).toBe(1);
    expect(pool.size).toBe(0);
  });

  it("makes provider-wide teardown idempotent", () => {
    const pool = new RuntimePool<object>();
    let cleanupCalls = 0;
    pool.register({}, () => cleanupCalls++);
    pool.register({}, () => cleanupCalls++);

    pool.cleanupAll();
    pool.cleanupAll();

    expect(cleanupCalls).toBe(2);
    expect(pool.size).toBe(0);
  });

  it("can unregister a naturally closed runtime without stopping it again", () => {
    const pool = new RuntimePool<object>();
    let cleanupCalls = 0;
    const handle = pool.register({}, () => cleanupCalls++);

    handle.unregister();
    pool.cleanupAll();

    expect(cleanupCalls).toBe(0);
    expect(pool.size).toBe(0);
  });
});
