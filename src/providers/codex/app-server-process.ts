import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import {
  assertCodexCliVersion,
  buildCodexProcessSpec,
  buildElectronSafePath,
} from "./codex-cli";

export interface AppServerReadable {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): this;
}

export interface AppServerWritable {
  write(value: string): boolean;
  end(): void;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface AppServerChildProcess {
  pid?: number;
  stdin: AppServerWritable;
  stdout: AppServerReadable;
  stderr: AppServerReadable;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal: NodeJS.Signals): boolean;
}

export type AppServerSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => AppServerChildProcess;

export interface AppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  error?: Error;
}

export interface SpawnCodexAppServerOptions {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxStderrBytes?: number;
  shutdownTimeoutMs?: number;
  forceKillGraceMs?: number;
  spawn?: AppServerSpawn;
  versionCheck?: (
    command: string,
    env: NodeJS.ProcessEnv,
  ) => void | Promise<void>;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  comspec?: string;
  runTerminationCommand?: RunTerminationCommand;
}

export interface CodexAppServerProcess {
  stdin: AppServerWritable;
  stdout: AppServerReadable;
  failure: Promise<AppServerExit>;
  exit: Promise<AppServerExit>;
  stop(): Promise<AppServerExit>;
}

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_FORCE_KILL_GRACE_MS = 1_000;

export type RunTerminationCommand = (
  file: string,
  args: string[],
) => Promise<void>;

export class AppServerLifecycleError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppServerLifecycleError";
  }
}

export async function spawnCodexAppServer(
  options: SpawnCodexAppServerOptions = {},
): Promise<CodexAppServerProcess> {
  const command = options.command ?? "codex";
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    PATH: buildElectronSafePath(
      sourceEnv.PATH,
      sourceEnv.HOME,
      platform,
      sourceEnv.APPDATA,
    ),
  };
  await (
    options.versionCheck ??
    ((binary, commandEnv) =>
      assertCodexCliVersion({
        command: binary,
        env: commandEnv,
        platform,
        fileExists: options.fileExists,
        comspec: options.comspec,
      }))
  )(command, env);
  const commandSpec = buildCodexProcessSpec(
    command,
    ["app-server", "--listen", "stdio://"],
    {
      platform,
      env,
      fileExists: options.fileExists,
      comspec: options.comspec,
    },
  );
  const spawn = options.spawn ?? (nodeSpawn as unknown as AppServerSpawn);
  const child = spawn(commandSpec.file, commandSpec.args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: commandSpec.windowsVerbatimArguments,
  });

  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  let stderr = Buffer.alloc(0);
  let closed = false;
  let failureReported = false;
  let exitSettled = false;
  let failure: Error | undefined;
  let resolveFailure!: (failure: AppServerExit) => void;
  const failurePromise = new Promise<AppServerExit>((resolve) => {
    resolveFailure = resolve;
  });
  let resolveExit!: (exit: AppServerExit) => void;
  let rejectExit!: (error: Error) => void;
  const exit = new Promise<AppServerExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  let resolveClosed!: (exit: AppServerExit) => void;
  const closedPromise = new Promise<AppServerExit>((resolve) => {
    resolveClosed = resolve;
  });

  const makeReport = (
    code: number | null,
    signal: NodeJS.Signals | null,
    error = failure,
  ): AppServerExit => ({
    code,
    signal,
    stderr: stderr.toString("utf8"),
    ...(error ? { error } : {}),
  });

  const reportFailure = (error: Error) => {
    if (failureReported) return;
    failure = error;
    failureReported = true;
    resolveFailure(makeReport(null, null, error));
  };

  const reportClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    if (closed) return;
    closed = true;
    const report = makeReport(code, signal);
    resolveClosed(report);
    if (!exitSettled) {
      exitSettled = true;
      resolveExit(report);
    }
  };

  let stopPromise: Promise<AppServerExit> | undefined;
  const stop = (): Promise<AppServerExit> => {
    if (stopPromise) return stopPromise;
    let resolveStop!: (report: AppServerExit) => void;
    let rejectStop!: (error: Error) => void;
    stopPromise = new Promise<AppServerExit>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    void stopChild({
      child,
      closed: closedPromise,
      isClosed: () => closed,
      isWindowsShim: commandSpec.windowsVerbatimArguments === true,
      shutdownTimeoutMs:
        options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      forceKillGraceMs:
        options.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS,
      runTerminationCommand:
        options.runTerminationCommand ?? runTerminationCommand,
      failure: () => failure,
    }).then(resolveStop, (error: unknown) => {
      const lifecycleError =
        error instanceof Error
          ? error
          : new AppServerLifecycleError(String(error), failure);
      if (closed) {
        void closedPromise.then(resolveStop);
        return;
      }
      reportFailure(lifecycleError);
      if (!exitSettled) {
        exitSettled = true;
        rejectExit(lifecycleError);
      }
      rejectStop(lifecycleError);
    });
    return stopPromise;
  };

  child.stderr.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    stderr = Buffer.concat([stderr, bytes]);
    if (stderr.length > maxStderrBytes) {
      stderr = stderr.subarray(stderr.length - maxStderrBytes);
    }
  });
  child.stdin.on("error", (error) => {
    if (closed) return;
    reportFailure(error);
    void stop().catch(() => undefined);
  });
  child.on("error", (error) => {
    if (closed) return;
    reportFailure(error);
    void stop().catch(() => undefined);
  });
  child.on("close", reportClose);

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    failure: failurePromise,
    exit,
    stop,
  };
}

interface StopChildOptions {
  child: AppServerChildProcess;
  closed: Promise<AppServerExit>;
  isClosed: () => boolean;
  isWindowsShim: boolean;
  shutdownTimeoutMs: number;
  forceKillGraceMs: number;
  runTerminationCommand: RunTerminationCommand;
  failure: () => Error | undefined;
}

async function stopChild(options: StopChildOptions): Promise<AppServerExit> {
  if (options.isClosed()) return options.closed;
  options.child.stdin.end();

  if (options.isWindowsShim) {
    if (await resolvesBefore(options.closed, options.shutdownTimeoutMs)) {
      return options.closed;
    }
    if (options.isClosed()) return options.closed;
    const pid = options.child.pid;
    if (pid === undefined) {
      throw new AppServerLifecycleError(
        "Cannot terminate the Windows Codex command shim tree: child PID is unavailable for taskkill.exe.",
        options.failure(),
      );
    }
    const termination = await settlesBefore(
      options.runTerminationCommand("taskkill.exe", [
        "/PID",
        String(pid),
        "/T",
        "/F",
      ]),
      options.forceKillGraceMs,
    );
    if (options.isClosed()) return options.closed;
    if (!termination) {
      throw new AppServerLifecycleError(
        `taskkill.exe did not finish while terminating Windows Codex process tree for PID ${pid}.`,
        options.failure(),
      );
    }
    if (termination.error) {
      throw new AppServerLifecycleError(
        `Failed to terminate Windows Codex process tree for PID ${pid} with taskkill.exe.`,
        termination.error,
      );
    }
    if (await resolvesBefore(options.closed, options.forceKillGraceMs)) {
      return options.closed;
    }
    if (options.isClosed()) return options.closed;
    throw new AppServerLifecycleError(
      `Windows Codex process tree for PID ${pid} did not close after taskkill.exe.`,
      options.failure(),
    );
  }

  options.child.kill("SIGTERM");
  if (await resolvesBefore(options.closed, options.shutdownTimeoutMs)) {
    return options.closed;
  }
  if (options.isClosed()) return options.closed;
  options.child.kill("SIGKILL");
  if (await resolvesBefore(options.closed, options.forceKillGraceMs)) {
    return options.closed;
  }
  if (options.isClosed()) return options.closed;
  throw new AppServerLifecycleError(
    "Codex app-server did not close after SIGTERM and SIGKILL.",
    options.failure(),
  );
}

function runTerminationCommand(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = nodeSpawn(file, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    command.on("error", reject);
    command.on("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new AppServerLifecycleError(
            `${file} exited with status ${String(code)} while terminating Codex.`,
          ),
        );
      }
    });
  });
}

async function resolvesBefore(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function settlesBefore(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<{ error?: unknown } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(
      () => ({}),
      (error: unknown) => ({ error }),
    ),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}
