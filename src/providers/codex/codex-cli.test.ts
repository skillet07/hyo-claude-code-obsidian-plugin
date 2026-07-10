import { EventEmitter } from "node:events";
import { delimiter, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexProcessSpec,
  type CodexProbeSpawn,
  CodexCliUnavailableError,
  MINIMUM_CODEX_CLI_VERSION,
  assertCodexCliVersion,
  buildElectronSafePath,
  parseCodexVersion,
  probeCodexVersion,
} from "./codex-cli";

class FakeProbeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killCalls: NodeJS.Signals[] = [];
  readonly pid = 2468;

  kill(signal: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

describe("Codex CLI version checks", () => {
  it("parses Codex CLI semantic versions", () => {
    expect(parseCodexVersion("codex-cli 0.144.1\n")).toEqual({
      major: 0,
      minor: 144,
      patch: 1,
      raw: "0.144.1",
    });
    expect(parseCodexVersion("codex 1.2.3-beta.1")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      raw: "1.2.3-beta.1",
    });
  });

  it("rejects unrecognized version output", () => {
    expect(() => parseCodexVersion("codex-cli unknown")).toThrow(
      /Could not parse Codex CLI version/,
    );
  });

  it("accepts the minimum supported version", async () => {
    await expect(
      assertCodexCliVersion({
        runVersion: () => "codex-cli 0.144.1",
      }),
    ).resolves.toMatchObject({ raw: MINIMUM_CODEX_CLI_VERSION });
  });

  it("does not treat a prerelease as satisfying the stable minimum", async () => {
    await expect(
      assertCodexCliVersion({ runVersion: () => "codex-cli 0.144.1-beta.1" }),
    ).rejects.toThrow(/requires 0\.144\.1/);
  });

  it("reports an actionable error for an old CLI", async () => {
    await expect(
      assertCodexCliVersion({ runVersion: () => "codex-cli 0.143.9" }),
    ).rejects.toThrow(/Found 0\.143\.9.*requires 0\.144\.1.*update/i);
  });

  it("reports an actionable error when the CLI is missing", async () => {
    const missing = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    await expect(
      assertCodexCliVersion({
        runVersion: () => {
          throw missing;
        },
      }),
    ).rejects.toThrow(/Codex CLI was not found.*install.*PATH/i);
  });

  it("uses a bounded timeout and preserves timeout details", async () => {
    const timeout = Object.assign(new Error("spawnSync codex ETIMEDOUT"), {
      code: "ETIMEDOUT",
      signal: "SIGTERM",
    });
    let caught: unknown;

    try {
      await assertCodexCliVersion({
        timeoutMs: 250,
        runVersion: (_spec, _env, timeoutMs) => {
          expect(timeoutMs).toBe(250);
          throw timeout;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CodexCliUnavailableError);
    expect(caught).toMatchObject({ cause: timeout });
    expect((caught as Error).message).toMatch(/timed out after 250ms.*ETIMEDOUT/i);
  });

  it("asynchronously force-kills a version probe that never closes", async () => {
    vi.useFakeTimers();
    const child = new FakeProbeProcess();
    const spawn = vi.fn<CodexProbeSpawn>(() => child);
    const probe = probeCodexVersion(
      { file: "codex", args: ["--version"] },
      {
        env: {},
        timeoutMs: 10,
        terminationGraceMs: 5,
        spawn,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(15);

    expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await probe).toMatchObject({
      name: "CodexCliProbeTimeoutError",
      timeoutMs: 10,
    });
    vi.useRealTimers();
  });

  it("bounds Windows probe tree termination when taskkill hangs", async () => {
    vi.useFakeTimers();
    const child = new FakeProbeProcess();
    const runTerminationCommand = vi.fn(
      () => new Promise<void>(() => undefined),
    );
    const probe = probeCodexVersion(
      {
        file: "cmd.exe",
        args: ["/d", "/s", "/c", '""C:\\npm\\codex.cmd" --version"'],
        windowsVerbatimArguments: true,
      },
      {
        env: {},
        timeoutMs: 10,
        terminationGraceMs: 5,
        spawn: () => child,
        runTerminationCommand,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(15);

    expect(runTerminationCommand).toHaveBeenCalledWith("taskkill.exe", [
      "/PID",
      "2468",
      "/T",
      "/F",
    ]);
    expect(await probe).toMatchObject({
      name: "CodexCliProbeTimeoutError",
      cause: expect.objectContaining({
        message: expect.stringMatching(/taskkill.*did not finish/i),
      }),
    });
    vi.useRealTimers();
  });

  it("resolves and safely wraps a Windows npm cmd shim", async () => {
    const shim = win32.join("C:\\npm", "codex.CMD");
    const spec = buildCodexProcessSpec("codex", ["--version"], {
      platform: "win32",
      env: {
        PATH: ["C:\\npm", "C:\\Windows"].join(win32.delimiter),
        PATHEXT: ".EXE;.CMD;.BAT",
      },
      fileExists: (path) => path === shim,
      comspec: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(spec).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `""${shim}" --version"`],
      windowsVerbatimArguments: true,
    });

    let probedSpec: unknown;
    await expect(
      assertCodexCliVersion({
        command: "codex",
        platform: "win32",
        env: {
          PATH: ["C:\\npm", "C:\\Windows"].join(win32.delimiter),
          PATHEXT: ".EXE;.CMD;.BAT",
        },
        fileExists: (path) => path === shim,
        comspec: "C:\\Windows\\System32\\cmd.exe",
        runVersion: (commandSpec) => {
          probedSpec = commandSpec;
          return "codex-cli 0.144.1";
        },
      }),
    ).resolves.toMatchObject({ raw: "0.144.1" });
    expect(probedSpec).toEqual(spec);
  });

  it("keeps a resolved Windows native executable shell-free", () => {
    const executable = win32.join("C:\\npm", "codex.EXE");
    const spec = buildCodexProcessSpec("codex", ["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\npm", PATHEXT: ".EXE;.CMD" },
      fileExists: (path) => path === executable,
    });

    expect(spec).toEqual({ file: executable, args: ["app-server"] });
  });

  it("rejects unsafe Windows shim command text instead of invoking a shell", () => {
    expect(() =>
      buildCodexProcessSpec("C:\\npm\\codex&calc.cmd", ["--version"], {
        platform: "win32",
        env: {},
      }),
    ).toThrow(/unsafe Windows command/i);
  });

  it("adds common GUI-missing executable directories without losing PATH", () => {
    const currentPath = ["/custom/bin", "/usr/bin"].join(delimiter);
    const path = buildElectronSafePath(currentPath, "/Users/tester");
    const entries = path.split(delimiter);

    expect(entries).toEqual(
      expect.arrayContaining([
        "/Users/tester/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/custom/bin",
      ]),
    );
    expect(new Set(entries).size).toBe(entries.length);
  });
});
