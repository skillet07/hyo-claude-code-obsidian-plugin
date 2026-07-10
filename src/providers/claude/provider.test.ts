import { describe, expect, it, vi } from "vitest";
import { createClaudeProvider } from "./provider";

describe("Claude provider async contract regression", () => {
  it("preserves synchronous filesystem behavior behind Promise-based services", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = createClaudeProvider({ cliPath: "/missing/claude" });
    const cwd = `/missing/hyo-contract-${Date.now()}`;

    const sessions = provider.listSessions(cwd);
    const history = provider.loadSession(cwd, "missing-session");

    expect(sessions).toBeInstanceOf(Promise);
    expect(history).toBeInstanceOf(Promise);
    await expect(sessions).resolves.toEqual([]);
    await expect(history).resolves.toEqual([]);
    expect(provider.capabilities).toMatchObject({
      models: false,
      skills: false,
      rateLimits: false,
      auth: false,
    });
    provider.cleanup();
    log.mockRestore();
  });
});
