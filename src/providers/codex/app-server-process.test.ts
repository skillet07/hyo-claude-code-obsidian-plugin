import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerExitedError,
  createProcessTransport,
} from "./app-server-client";
import { type AppServerSpawn, spawnCodexAppServer } from "./app-server-process";

class FakeStdin extends EventEmitter {
  endCalls = 0;
  writes: string[] = [];

  constructor() {
    super();
  }

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
  readonly pid: number | undefined;

  constructor(
    private readonly closeOnKill = true,
    pid: number | null = 1234,
  ) {
    super();
    this.pid = pid ?? undefined;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

describe("spawnCodexAppServer", () => {
  it("checks the CLI version before spawning and does not fall back", async () => {
    const spawn = vi.fn<AppServerSpawn>();
    const versionCheck = vi.fn(() => {
      throw new Error("Codex CLI is too old");
    });

    await expect(spawnCodexAppServer({ spawn, versionCheck })).rejects.toThrow(
      "Codex CLI is too old",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns the documented stdio server with cwd and Electron-safe env", async () => {
    const child = new FakeProcess();
    const spawn = vi.fn<AppServerSpawn>(() => child);

    await spawnCodexAppServer({
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

  it("uses the safe Windows shim spec for app-server spawn", async () => {
    const child = new FakeProcess();
    const spawn = vi.fn<AppServerSpawn>(() => child);
    const shim = win32.join("C:\\npm", "codex.CMD");

    await spawnCodexAppServer({
      env: { PATH: "C:\\npm", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      fileExists: (path) => path === shim,
      comspec: "C:\\Windows\\System32\\cmd.exe",
      spawn,
      versionCheck: () => undefined,
    });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        `""${shim}" app-server --listen stdio://"`,
      ],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
  });

  it("captures bounded stderr and reports close details", async () => {
    const child = new FakeProcess();
    const server = await spawnCodexAppServer({
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
    const server = await spawnCodexAppServer({
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

  it("captures stdin EPIPE during a write-close race", async () => {
    const child = new FakeProcess();
    const server = await spawnCodexAppServer({
      spawn: () => child,
      versionCheck: () => undefined,
    });
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const transport = createProcessTransport(server);
    const pending = transport.request("thread/list", {}).catch((reason) => reason);

    child.stdin.emit("error", error);
    child.emit("close", 0, null);

    await expect(server.exit).resolves.toMatchObject({
      code: null,
      signal: null,
      error,
    });
    const rejection = await pending;
    expect(rejection).toBeInstanceOf(CodexAppServerExitedError);
    expect(rejection).toMatchObject({ exit: { error } });
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  it("escalates after stdin EPIPE when the OS child never closes", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess(false);
    const server = await spawnCodexAppServer({
      spawn: () => child,
      versionCheck: () => undefined,
      shutdownTimeoutMs: 10,
      forceKillGraceMs: 10,
    });
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    child.stdin.emit("error", error);
    const stopped = server.stop().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await stopped).toMatchObject({
      name: "AppServerLifecycleError",
      cause: error,
    });
    vi.useRealTimers();
  });

  it("tree-terminates a Windows shim exactly once after graceful timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess(false, 4321);
    const shim = win32.join("C:\\npm", "codex.CMD");
    const runTerminationCommand = vi.fn(async () => {
      child.emit("close", null, null);
    });
    const server = await spawnCodexAppServer({
      env: { PATH: "C:\\npm", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      fileExists: (path) => path === shim,
      spawn: () => child,
      versionCheck: () => undefined,
      shutdownTimeoutMs: 10,
      forceKillGraceMs: 10,
      runTerminationCommand,
    });

    const stopped = server.stop();
    expect(child.stdin.endCalls).toBe(1);
    expect(child.killCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    await stopped;

    expect(runTerminationCommand).toHaveBeenCalledTimes(1);
    expect(runTerminationCommand).toHaveBeenCalledWith("taskkill.exe", [
      "/PID",
      "4321",
      "/T",
      "/F",
    ]);
    expect(child.killCalls).toEqual([]);
    vi.useRealTimers();
  });

  it("reports an actionable error when a Windows shim child has no PID", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess(false, null);
    const shim = win32.join("C:\\npm", "codex.CMD");
    const server = await spawnCodexAppServer({
      env: { PATH: "C:\\npm", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      fileExists: (path) => path === shim,
      spawn: () => child,
      versionCheck: () => undefined,
      shutdownTimeoutMs: 10,
      forceKillGraceMs: 10,
    });
    const stopped = server.stop().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(await stopped).toMatchObject({ name: "AppServerLifecycleError" });
    expect((await stopped as Error).message).toMatch(/Windows.*PID.*taskkill/i);
    vi.useRealTimers();
  });

  it("bounds a hung Windows taskkill invocation", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess(false, 4321);
    const shim = win32.join("C:\\npm", "codex.CMD");
    const runTerminationCommand = vi.fn(
      () => new Promise<void>(() => undefined),
    );
    const server = await spawnCodexAppServer({
      env: { PATH: "C:\\npm", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      fileExists: (path) => path === shim,
      spawn: () => child,
      versionCheck: () => undefined,
      shutdownTimeoutMs: 10,
      forceKillGraceMs: 10,
      runTerminationCommand,
    });
    const stopped = server.stop().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    await vi.advanceTimersByTimeAsync(20);

    expect(runTerminationCommand).toHaveBeenCalledTimes(1);
    expect(await stopped).toMatchObject({
      name: "AppServerLifecycleError",
      message: expect.stringMatching(/taskkill.*did not finish/i),
    });
    vi.useRealTimers();
  });

  it("swallows a late stdin EPIPE after process close", async () => {
    const child = new FakeProcess();
    const server = await spawnCodexAppServer({
      spawn: () => child,
      versionCheck: () => undefined,
    });
    child.emit("close", 0, null);

    expect(() => child.stdin.emit("error", new Error("late EPIPE"))).not.toThrow();
    const exit = await server.exit;
    expect(exit).toMatchObject({ code: 0 });
    expect(exit).not.toHaveProperty("error");
    expect(child.killCalls).toEqual([]);
  });

  it("makes shutdown idempotent", async () => {
    const child = new FakeProcess();
    const server = await spawnCodexAppServer({
      spawn: () => child,
      versionCheck: () => undefined,
    });

    await Promise.all([server.stop(), server.stop(), server.stop()]);

    expect(child.stdin.endCalls).toBe(1);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });
});
