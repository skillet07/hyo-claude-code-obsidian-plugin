import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  buildTypegenCommandSpec,
  getCodexCliCommand,
  runTypegenCommandSync,
} from "./codex-typegen-lib.mjs";
import {
  assertCodexSmokeOptIn,
  assertCollabSmokeEvidence,
  buildSmokeProtocol,
  createJsonlDecoder,
  observeCollabSmokeMessage,
} from "./codex-smoke-lib.mjs";

const TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MINIMUM_CODEX_CLI_VERSION = "0.144.1";

let child;
let activeTurn;
let peer;
let cleanupStarted = false;
const pending = new Map();

try {
  assertCodexSmokeOptIn(process.env);
  const { cwd, fixture } = validateFixture(process.env);
  const command = getCodexCliCommand(process.env);
  assertMinimumVersion(command, cwd);
  const protocol = buildSmokeProtocol({ cwd, fixture });
  const processSpec = buildTypegenCommandSpec(command, ["app-server", "--listen", "stdio://"]);
  child = spawn(processSpec.file, processSpec.args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: processSpec.windowsVerbatimArguments,
  });

  let fail;
  const fatal = new Promise((_, reject) => {
    fail = reject;
  });
  const state = {};
  let turnCompleted = false;
  let nextId = 1;
  let resolveTurn;
  const completed = new Promise((resolveCompleted) => {
    resolveTurn = resolveCompleted;
  });

  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  peer = {
    notify(method, params) {
      write(params === undefined ? { method } : { method, params });
    },
    request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`Stable app-server request ${method} timed out`));
        }, timeoutMs);
        pending.set(id, { method, timer, resolve: resolveRequest, reject: rejectRequest });
        write({ id, method, params });
      });
    },
  };

  const decoder = createJsonlDecoder((message) => {
    if (Object.hasOwn(message, "id") && !message.method) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`Stable app-server request ${request.method} failed`));
      else request.resolve(message.result);
      return;
    }
    if (message.method && Object.hasOwn(message, "id")) {
      write({
        id: message.id,
        error: {
          code: -32000,
          message: "Hyo smoke refuses approvals, questions, and other server requests",
        },
      });
      fail(new Error(`Smoke stopped safely on server request ${message.method}`));
      return;
    }
    observeCollabSmokeMessage(state, message);
    if (message.method === "turn/completed") {
      const status = message.params?.turn?.status;
      turnCompleted = true;
      activeTurn = undefined;
      if (status !== "completed") {
        fail(new Error(`Codex smoke turn ended with status ${String(status)}`));
      } else {
        resolveTurn();
      }
    }
  });
  child.stdout.on("data", (chunk) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.on("data", () => undefined);
  child.stdin.on("error", () => {
    if (!cleanupStarted) fail(new Error("Codex app-server stdin closed unexpectedly"));
  });
  child.on("error", () => fail(new Error("Could not start codex app-server")));
  child.on("close", (code, signal) => {
    if (!cleanupStarted && !turnCompleted) {
      fail(new Error(`codex app-server exited early (${code ?? signal ?? "unknown"}); stderr withheld`));
    }
  });

  const timeout = setTimeout(
    () => fail(new Error(`Codex smoke exceeded its strict ${TIMEOUT_MS}ms timeout`)),
    TIMEOUT_MS,
  );
  const race = (promise) => Promise.race([promise, fatal]);
  try {
    await race(peer.request(protocol.initialize.method, protocol.initialize.params));
    peer.notify(protocol.initialized.method);
    const thread = await race(peer.request(protocol.threadStart.method, protocol.threadStart.params));
    const threadId = thread?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new Error("thread/start returned no thread id");
    }
    const turnParams = { ...protocol.turnStart.params, threadId };
    const turn = await race(peer.request(protocol.turnStart.method, turnParams));
    const turnId = turn?.turn?.id;
    if (typeof turnId !== "string" || !turnId) {
      throw new Error("turn/start returned no turn id");
    }
    if (!turnCompleted) activeTurn = { threadId, turnId };
    await race(completed);
    assertCollabSmokeEvidence(state);
    console.log("Codex smoke passed: received real spawn and terminal collaboration events.");
  } finally {
    clearTimeout(timeout);
  }
} catch (error) {
  console.error(redactError(error));
  process.exitCode = 1;
} finally {
  await cleanup();
}

function validateFixture(env) {
  if (!env.HYO_CODEX_SMOKE_CWD || !isAbsolute(env.HYO_CODEX_SMOKE_CWD)) {
    throw new Error("Set HYO_CODEX_SMOKE_CWD to an absolute, caller-owned safe fixture directory.");
  }
  if (!env.HYO_CODEX_SMOKE_FIXTURE) {
    throw new Error("Set HYO_CODEX_SMOKE_FIXTURE to one existing file inside HYO_CODEX_SMOKE_CWD.");
  }
  const cwd = realpathSync(env.HYO_CODEX_SMOKE_CWD);
  if (!statSync(cwd).isDirectory()) throw new Error("HYO_CODEX_SMOKE_CWD must be a directory.");
  const fixturePath = realpathSync(resolve(cwd, env.HYO_CODEX_SMOKE_FIXTURE));
  const fixture = relative(cwd, fixturePath);
  if (!fixture || fixture.startsWith("..") || isAbsolute(fixture)) {
    throw new Error("HYO_CODEX_SMOKE_FIXTURE must stay inside HYO_CODEX_SMOKE_CWD.");
  }
  if (!statSync(fixturePath).isFile()) throw new Error("HYO_CODEX_SMOKE_FIXTURE must be a file.");
  return { cwd, fixture };
}

function assertMinimumVersion(command, cwd) {
  const output = runTypegenCommandSync(command, ["--version"], { cwd, timeout: 3_000 });
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?\b/);
  if (
    !match ||
    match[4]?.startsWith("-") ||
    compareVersions(match.slice(1, 4), MINIMUM_CODEX_CLI_VERSION.split(".")) < 0
  ) {
    throw new Error(`Codex CLI ${MINIMUM_CODEX_CLI_VERSION} or newer is required for this smoke.`);
  }
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference) return difference;
  }
  return 0;
}

async function cleanup() {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Codex smoke is shutting down"));
  }
  pending.clear();
  if (!child || cleanupStarted) return;
  cleanupStarted = true;
  if (activeTurn && peer) {
    await peer.request("turn/interrupt", activeTurn, 1_500).catch(() => undefined);
    activeTurn = undefined;
  }
  child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveCleanup) => {
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolveCleanup();
    }, 2_000);
    child.once("close", () => {
      clearTimeout(force);
      resolveCleanup();
    });
  });
}

function redactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, "<redacted>")
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.exitCode = 1;
    void cleanup().finally(() => process.exit(1));
  });
}
