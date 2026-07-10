import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { type AppServerSpawn, spawnCodexAppServer } from "./app-server-process";

class FakeStdin {
  endCalls = 0;
  writes: string[] = [];

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }

  end(): void {
    this.endCalls += 1;
  }
}

class FakeProcess extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killCalls: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

describe("spawnCodexAppServer", () => {
  it("checks the CLI version before spawning and does not fall back", () => {
    const spawn = vi.fn<AppServerSpawn>();
    const versionCheck = vi.fn(() => {
      throw new Error("Codex CLI is too old");
    });

    expect(() => spawnCodexAppServer({ spawn, versionCheck })).toThrow(
      "Codex CLI is too old",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns the documented stdio server with cwd and Electron-safe env", () => {
    const child = new FakeProcess();
    const spawn = vi.fn<AppServerSpawn>(() => child);

    spawnCodexAppServer({
      cwd: "/vault",
      env: { PATH: "/custom/bin", CUSTOM: "yes", HOME: "/Users/tester" },
      spawn,
      versionCheck: () => undefined,
    });

    expect(spawn).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({
        cwd: "/vault",
        stdio: ["pipe", "pipe", "pipe"],
        env: expect.objectContaining({ CUSTOM: "yes" }),
      }),
    );
    const env = spawn.mock.calls[0]![2].env!;
    expect(env.PATH).toContain("/Users/tester/.local/bin");
    expect(env.PATH).toContain("/custom/bin");
  });

  it("captures bounded stderr and reports close details", async () => {
    const child = new FakeProcess();
    const server = spawnCodexAppServer({
      spawn: () => child,
      maxStderrBytes: 11,
      versionCheck: () => undefined,
    });

    child.stderr.write("first-");
    child.stderr.write("second-tail");
    child.emit("close", 17, null);

    await expect(server.exit).resolves.toEqual({
      code: 17,
      signal: null,
      stderr: "second-tail",
    });
  });

  it("reports process errors once even if close follows", async () => {
    const child = new FakeProcess();
    const server = spawnCodexAppServer({
      spawn: () => child,
      versionCheck: () => undefined,
    });
    const error = new Error("spawn failed");

    child.emit("error", error);
    child.emit("close", null, null);

    await expect(server.exit).resolves.toMatchObject({
      code: null,
      signal: null,
      error,
    });
  });

  it("makes shutdown idempotent", async () => {
    const child = new FakeProcess();
    const server = spawnCodexAppServer({
      spawn: () => child,
      versionCheck: () => undefined,
    });

    await Promise.all([server.stop(), server.stop(), server.stop()]);

    expect(child.stdin.endCalls).toBe(1);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });
});
