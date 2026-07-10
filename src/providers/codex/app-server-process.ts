import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { assertCodexCliVersion, buildElectronSafePath } from "./codex-cli";

export interface AppServerReadable {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): this;
}

export interface AppServerWritable {
  write(value: string): boolean;
  end(): void;
}

export interface AppServerChildProcess {
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
  spawn?: AppServerSpawn;
  versionCheck?: (command: string, env: NodeJS.ProcessEnv) => void;
}

export interface CodexAppServerProcess {
  stdin: AppServerWritable;
  stdout: AppServerReadable;
  exit: Promise<AppServerExit>;
  stop(): Promise<AppServerExit>;
}

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

export function spawnCodexAppServer(
  options: SpawnCodexAppServerOptions = {},
): CodexAppServerProcess {
  const command = options.command ?? "codex";
  const sourceEnv = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    PATH: buildElectronSafePath(sourceEnv.PATH, sourceEnv.HOME),
  };
  (
    options.versionCheck ??
    ((binary, commandEnv) => {
      assertCodexCliVersion({ command: binary, env: commandEnv });
    })
  )(command, env);
  const spawn = options.spawn ?? (nodeSpawn as unknown as AppServerSpawn);
  const child = spawn(command, ["app-server", "--listen", "stdio://"], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  let stderr = Buffer.alloc(0);
  let exited = false;
  let resolveExit!: (exit: AppServerExit) => void;
  const exit = new Promise<AppServerExit>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ) => {
    if (exited) return;
    exited = true;
    resolveExit({
      code,
      signal,
      stderr: stderr.toString("utf8"),
      ...(error ? { error } : {}),
    });
  };

  child.stderr.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    stderr = Buffer.concat([stderr, bytes]);
    if (stderr.length > maxStderrBytes) {
      stderr = stderr.subarray(stderr.length - maxStderrBytes);
    }
  });
  child.on("error", (error) => settle(null, null, error));
  child.on("close", (code, signal) => settle(code, signal));

  let stopPromise: Promise<AppServerExit> | undefined;
  const stop = () => {
    stopPromise ??= stopChild(
      child,
      exit,
      () => exited,
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      settle,
    );
    return stopPromise;
  };

  return { stdin: child.stdin, stdout: child.stdout, exit, stop };
}

async function stopChild(
  child: AppServerChildProcess,
  exit: Promise<AppServerExit>,
  hasExited: () => boolean,
  timeoutMs: number,
  settle: (code: null, signal: NodeJS.Signals) => void,
): Promise<AppServerExit> {
  if (hasExited()) return exit;
  child.stdin.end();
  if (!hasExited()) child.kill("SIGTERM");
  if (await resolvesBefore(exit, timeoutMs)) return exit;

  if (!hasExited()) child.kill("SIGKILL");
  if (await resolvesBefore(exit, timeoutMs)) return exit;

  settle(null, "SIGKILL");
  return exit;
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
