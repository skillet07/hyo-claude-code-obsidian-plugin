import { describe, expect, it, vi } from "vitest";
import { SessionLifecycle } from "../../hooks/session-lifecycle";
import type { ProviderEvent } from "../types";
import type { CodexAppServerProcess } from "./app-server-process";
import {
  CodexProvider,
  CodexRuntime,
  type CodexClientFactory,
  type CodexConnectionHandlers,
  type CodexProviderClient,
} from "./provider";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/vault",
    cliVersion: "0.144.1",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function createProcessController() {
  const failure = deferred<any>();
  const exit = deferred<any>();
  const stop = vi.fn(async () => {
    const report = { code: 0, signal: null, stderr: "" };
    exit.resolve(report);
    return report;
  });
  const process = {
    stdin: { write: vi.fn(() => true), end: vi.fn(), on() { return this; } },
    stdout: { on() { return this; } },
    failure: failure.promise,
    exit: exit.promise,
    stop,
  } as unknown as CodexAppServerProcess;
  return {
    process,
    stop,
    crash(message = "boom") {
      const report = { code: 1, signal: null, stderr: message };
      failure.resolve(report);
      exit.resolve(report);
    },
  };
}

function createHarness(clientOverrides: Partial<CodexProviderClient> = {}) {
  const processes = [createProcessController(), createProcessController()];
  const processFactory = vi.fn(async () => processes.shift()!.process);
  const handlers: CodexConnectionHandlers[] = [];
  const dispose = vi.fn();
  let nextThread = 1;
  let nextTurn = 1;
  const client: CodexProviderClient = {
    threadStart: vi.fn(async () => ({ thread: thread(`thread-${nextThread++}`) } as never)),
    threadResume: vi.fn(async ({ threadId }) => ({ thread: thread(threadId) } as never)),
    turnStart: vi.fn(async () => ({ turn: { id: `turn-${nextTurn++}`, items: [], status: "inProgress" } } as never)),
    turnInterrupt: vi.fn(async () => ({} as never)),
    threadCompact: vi.fn(async () => ({} as never)),
    threadSetName: vi.fn(async () => ({} as never)),
    threadList: vi.fn(async () => ({ data: [], nextCursor: null, backwardsCursor: null })),
    threadRead: vi.fn(async ({ threadId }) => ({ thread: thread(threadId) } as never)),
    modelList: vi.fn(async () => ({ data: [], nextCursor: null })),
    skillsList: vi.fn(async () => ({ data: [] })),
    accountRateLimitsRead: vi.fn(async () => ({} as never)),
    accountRead: vi.fn(async () => ({ account: null, requiresOpenaiAuth: true })),
    startChatGptBrowserLogin: vi.fn(async () => ({ type: "chatgpt" as const, loginId: "login", authUrl: "https://login" })),
    startChatGptDeviceLogin: vi.fn(async () => ({ type: "chatgptDeviceCode" as const, loginId: "device", verificationUrl: "https://device", userCode: "CODE" })),
    cancelAccountLogin: vi.fn(async () => ({} as never)),
    ...clientOverrides,
  };
  const clientFactory = vi.fn<CodexClientFactory>(async (_process, nextHandlers) => {
    handlers.push(nextHandlers);
    return { client, dispose };
  });
  const provider = new CodexProvider({
    appVersion: "0.3.0",
    processFactory,
    clientFactory,
  });
  return { provider, client, handlers, processFactory, clientFactory, dispose, processes };
}

function runtimeOptions(onEvent: (event: ProviderEvent) => void, extra: Record<string, unknown> = {}) {
  return {
    cwd: "/vault",
    model: "gpt-5.4",
    permissionMode: "manual",
    onEvent,
    ...extra,
  };
}

async function expectAcceptedTurnToFailOnce(
  provider: CodexProvider,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const lifecycle = new SessionLifecycle<ReturnType<CodexProvider["createRuntime"]>>();
  const finishTurn = vi.spyOn(lifecycle, "finishTurn");
  expect(lifecycle.beginTurn("tab-1")).toBe(true);
  const runtime = provider.createRuntime(runtimeOptions((event) => {
    if (event.type === "turn_completed") lifecycle.finishTurn("tab-1");
  }, extra));
  lifecycle.attachRuntime("tab-1", runtime);

  runtime.start();
  runtime.send("accepted");

  await vi.waitFor(() => expect(finishTurn).toHaveBeenCalledTimes(1));
  expect(lifecycle.beginTurn("tab-1")).toBe(true);
  provider.cleanup();
}

describe("CodexProvider runtime lifecycle", () => {
  it("terminates an accepted turn once when connection initialization fails", async () => {
    const process = createProcessController();
    const provider = new CodexProvider({
      appVersion: "0.3.0",
      processFactory: async () => process.process,
      clientFactory: async () => {
        throw new Error("initialize failed");
      },
    });

    await expectAcceptedTurnToFailOnce(provider);
  });

  it("terminates an accepted turn once when thread/start fails", async () => {
    const threadStart = vi.fn(async () => {
      throw new Error("thread start failed");
    });
    const { provider } = createHarness({ threadStart });

    await expectAcceptedTurnToFailOnce(provider);
  });

  it("terminates an accepted turn once when thread/resume fails", async () => {
    const threadResume = vi.fn(async () => {
      throw new Error("thread resume failed");
    });
    const { provider } = createHarness({ threadResume });

    await expectAcceptedTurnToFailOnce(provider, {
      providerSessionId: "thread-existing",
      resume: true,
    });
  });

  it("shares one lazy client across two runtimes and keeps concurrent turns scoped", async () => {
    const { provider, client, processFactory, clientFactory } = createHarness();
    const firstEvents: ProviderEvent[] = [];
    const secondEvents: ProviderEvent[] = [];
    const first = provider.createRuntime(runtimeOptions((event) => firstEvents.push(event)));
    const second = provider.createRuntime(runtimeOptions((event) => secondEvents.push(event)));

    expect(processFactory).not.toHaveBeenCalled();
    first.start();
    second.start();
    first.send("first");
    second.send("second");

    await vi.waitFor(() => expect(client.turnStart).toHaveBeenCalledTimes(2));
    expect(processFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(client.threadStart).toHaveBeenNthCalledWith(1, {
      cwd: "/vault",
      model: "gpt-5.4",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(client.turnStart).toHaveBeenCalledWith({
      threadId: "thread-1",
      input: [{ type: "text", text: "first", text_elements: [] }],
    });
    expect(client.turnStart).toHaveBeenCalledWith({
      threadId: "thread-2",
      input: [{ type: "text", text: "second", text_elements: [] }],
    });
    expect(firstEvents).toContainEqual(expect.objectContaining({ type: "session_metadata", sessionId: "thread-1" }));
    expect(secondEvents).toContainEqual(expect.objectContaining({ type: "session_metadata", sessionId: "thread-2" }));
  });

  it("buffers an early notification until turn/start returns and then flushes it", async () => {
    let handlers!: CodexConnectionHandlers;
    const turnStart = vi.fn(async ({ threadId }) => {
      handlers.onNotification({
        method: "item/agentMessage/delta",
        params: { threadId, turnId: "turn-early", itemId: "item-1", delta: "early" },
      });
      return { turn: { id: "turn-early", items: [], status: "inProgress" } } as never;
    });
    const harness = createHarness({ turnStart });
    const events: ProviderEvent[] = [];
    const runtime = harness.provider.createRuntime(runtimeOptions((event) => events.push(event)));
    runtime.start();
    await vi.waitFor(() => expect(harness.handlers).toHaveLength(1));
    handlers = harness.handlers[0]!;
    runtime.send("hello");

    await vi.waitFor(() => expect(events).toContainEqual({ type: "text_delta", delta: "early", itemId: "item-1" }));
  });

  it("buffers an early server request until its exact turn is bound", async () => {
    let handlers!: CodexConnectionHandlers;
    let earlyApproval!: Promise<unknown>;
    const turnResponse = deferred<any>();
    const turnStart = vi.fn(({ threadId }) => {
      earlyApproval = handlers.onServerRequest({
        id: "early-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId, turnId: "turn-early", itemId: "item-early",
          command: "pwd", cwd: "/vault", reason: null,
          environmentId: "env", approvalId: null, commandActions: null,
          networkApprovalContext: null, proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        },
      });
      return turnResponse.promise;
    });
    const harness = createHarness({ turnStart });
    const events: ProviderEvent[] = [];
    const runtime = harness.provider.createRuntime(runtimeOptions((event) => events.push(event)));
    runtime.start();
    await vi.waitFor(() => expect(harness.handlers).toHaveLength(1));
    handlers = harness.handlers[0]!;
    await vi.waitFor(() => expect(runtime.ready).toBe(true));

    runtime.send("hello");
    await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(1));
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);

    turnResponse.resolve({
      turn: { id: "turn-early", items: [], status: "inProgress" },
    });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "approval_requested",
      requestId: "string:early-approval",
      threadId: "thread-1",
      turnId: "turn-early",
    })));
    runtime.respondApproval("string:early-approval", "deny");
    await expect(earlyApproval).resolves.toEqual({ decision: "decline" });
  });

  it("cancels an exact-turn request buffered for a failed turn/start", async () => {
    let handlers!: CodexConnectionHandlers;
    let earlyApproval!: Promise<unknown>;
    const turnResponse = deferred<any>();
    const turnStart = vi.fn(({ threadId }) => {
      earlyApproval = handlers.onServerRequest({
        id: "failed-early-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId, turnId: "turn-failed", itemId: "item-failed",
          command: "pwd", cwd: "/vault", reason: null,
          environmentId: "env", approvalId: null, commandActions: null,
          networkApprovalContext: null, proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        },
      });
      return turnResponse.promise;
    });
    const harness = createHarness({ turnStart });
    const runtime = harness.provider.createRuntime(runtimeOptions(() => undefined));
    runtime.start();
    await vi.waitFor(() => expect(harness.handlers).toHaveLength(1));
    handlers = harness.handlers[0]!;
    await vi.waitFor(() => expect(runtime.ready).toBe(true));
    runtime.send("hello");
    await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(1));

    turnResponse.reject(new Error("turn start failed"));

    await expect(Promise.race([
      earlyApproval,
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 25)),
    ])).resolves.toEqual({ decision: "cancel" });
  });

  it("does not deliver a buffered request after the server resolves it", async () => {
    let handlers!: CodexConnectionHandlers;
    let earlyApproval!: Promise<unknown>;
    const turnResponse = deferred<any>();
    const turnStart = vi.fn(({ threadId }) => {
      earlyApproval = handlers.onServerRequest({
        id: "resolved-early-approval",
        method: "item/fileChange/requestApproval",
        params: {
          threadId, turnId: "turn-resolved", itemId: "item-resolved",
          startedAtMs: 1, reason: null, grantRoot: null,
        },
      });
      return turnResponse.promise;
    });
    const harness = createHarness({ turnStart });
    const events: ProviderEvent[] = [];
    const runtime = harness.provider.createRuntime(runtimeOptions((event) => events.push(event)));
    runtime.start();
    await vi.waitFor(() => expect(harness.handlers).toHaveLength(1));
    handlers = harness.handlers[0]!;
    await vi.waitFor(() => expect(runtime.ready).toBe(true));
    runtime.send("hello");
    await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(1));

    handlers.onNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "resolved-early-approval" },
    });
    await expect(earlyApproval).resolves.toBeNull();
    turnResponse.resolve({
      turn: { id: "turn-resolved", items: [], status: "inProgress" },
    });
    await vi.waitFor(() => expect(runtime.ready).toBe(true));
    await Promise.resolve();

    expect(events.some((event) => event.type === "approval_requested")).toBe(false);
  });

  it("atomically owns an early request before a buffered terminal event flushes", async () => {
    let handlers!: CodexConnectionHandlers;
    let earlyApproval!: Promise<unknown>;
    const turnStart = vi.fn(async ({ threadId }) => {
      earlyApproval = handlers.onServerRequest({
        id: "terminal-early-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId, turnId: "turn-terminal", itemId: "item-terminal",
          command: "pwd", cwd: "/vault", reason: null,
          environmentId: "env", approvalId: null, commandActions: null,
          networkApprovalContext: null, proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        },
      });
      handlers.onNotification({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "turn-terminal", status: "completed", items: [] },
        },
      });
      return {
        turn: { id: "turn-terminal", items: [], status: "inProgress" },
      } as never;
    });
    const harness = createHarness({ turnStart });
    const events: ProviderEvent[] = [];
    const runtime = harness.provider.createRuntime(runtimeOptions((event) => events.push(event)));
    runtime.start();
    await vi.waitFor(() => expect(harness.handlers).toHaveLength(1));
    handlers = harness.handlers[0]!;
    await vi.waitFor(() => expect(runtime.ready).toBe(true));

    runtime.send("hello");

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      status: "completed",
    })));
    await expect(Promise.race([
      earlyApproval,
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 25)),
    ])).resolves.toEqual({ decision: "cancel" });
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);
  });

  it("auto-cancels an old-turn request after a replacement resumes the same thread", async () => {
    const { provider, client, handlers } = createHarness();
    const firstEvents: ProviderEvent[] = [];
    const first = provider.createRuntime(runtimeOptions((event) => firstEvents.push(event), {
      providerSessionId: "thread-shared",
      resume: true,
    }));
    first.start();
    first.send("first turn");
    await vi.waitFor(() => expect(client.turnStart).toHaveBeenCalledTimes(1));
    first.cleanup();

    const replacementEvents: ProviderEvent[] = [];
    const replacement = provider.createRuntime(runtimeOptions(
      (event) => replacementEvents.push(event),
      { providerSessionId: "thread-shared", resume: true },
    ));
    replacement.start();
    replacement.send("replacement turn");
    await vi.waitFor(() => expect(client.turnStart).toHaveBeenCalledTimes(2));

    const late = handlers[0]!.onServerRequest({
      id: "old-turn-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-shared", turnId: "turn-1", itemId: "old-item",
        command: "pwd", cwd: "/vault", reason: null,
        environmentId: "env", approvalId: null, commandActions: null,
        networkApprovalContext: null, proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    });

    await expect(Promise.race([
      late,
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 25)),
    ])).resolves.toEqual({ decision: "cancel" });
    expect(replacementEvents.some((event) => event.type === "approval_requested"))
      .toBe(false);
  });

  it("resumes existing threads and supports interrupt, compact, and rename", async () => {
    const { provider, client } = createHarness();
    const runtime = provider.createRuntime(runtimeOptions(() => undefined, {
      providerState: { threadId: "thread-existing", currentTurnId: "turn-prior" },
      resume: true,
    }));
    runtime.start();
    runtime.send("continue");
    await vi.waitFor(() => expect(client.turnStart).toHaveBeenCalledTimes(1));

    expect(client.threadResume).toHaveBeenCalledWith({
      threadId: "thread-existing",
      cwd: "/vault",
      model: "gpt-5.4",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(client.threadStart).not.toHaveBeenCalled();
    runtime.interrupt();
    runtime.compact();
    await provider.renameSession("/vault", "thread-existing", "Renamed");
    await vi.waitFor(() => expect(client.turnInterrupt).toHaveBeenCalledWith({ threadId: "thread-existing", turnId: "turn-1" }));
    expect(client.threadCompact).toHaveBeenCalledWith({ threadId: "thread-existing" });
    expect(client.threadSetName).toHaveBeenCalledWith({ threadId: "thread-existing", name: "Renamed" });
  });

  it("fails an active turn once on crash and lazily resumes it on a fresh client", async () => {
    const firstProcess = createProcessController();
    const secondProcess = createProcessController();
    const processFactory = vi.fn()
      .mockResolvedValueOnce(firstProcess.process)
      .mockResolvedValueOnce(secondProcess.process);
    const clients: CodexProviderClient[] = [];
    const clientFactory: CodexClientFactory = async () => {
      const index = clients.length;
      const client = createHarness().client;
      if (index === 1) {
        (client.threadResume as ReturnType<typeof vi.fn>).mockResolvedValue({ thread: thread("thread-1") });
      }
      clients.push(client);
      return { client, dispose: vi.fn() };
    };
    const provider = new CodexProvider({ appVersion: "0.3.0", processFactory, clientFactory });
    const events: ProviderEvent[] = [];
    const runtime = provider.createRuntime(runtimeOptions((event) => events.push(event)));
    runtime.start();
    runtime.send("first");
    await vi.waitFor(() => expect(clients[0]?.turnStart).toHaveBeenCalledTimes(1));

    firstProcess.crash("lost transport");
    await vi.waitFor(() => expect(events.filter((event) => event.type === "turn_completed" && event.status === "failed")).toHaveLength(1));
    expect(runtime.ready).toBe(false);

    runtime.send("retry");
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() => expect(clients[1]?.turnStart).toHaveBeenCalledTimes(1));
    expect(clients[1]?.threadResume).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1" }));
    expect(events.filter((event) => event.type === "turn_completed" && event.status === "failed")).toHaveLength(1);
  });

  it("fails exactly once when the process watcher and pending turn RPC both fail", async () => {
    const process = createProcessController();
    const pendingTurn = deferred<any>();
    const turnStart = vi.fn(() => pendingTurn.promise);
    const harness = createHarness({ turnStart });
    (harness.processFactory as ReturnType<typeof vi.fn>).mockResolvedValue(process.process);
    const events: ProviderEvent[] = [];
    const runtime = harness.provider.createRuntime(runtimeOptions((event) => events.push(event)));
    runtime.start();
    runtime.send("pending");
    await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(1));

    process.crash("transport closed");
    pendingTurn.reject(new Error("transport closed"));

    await vi.waitFor(() => expect(events.some((event) => event.type === "turn_completed")).toBe(true));
    expect(events.filter((event) => event.type === "turn_completed" && event.status === "failed"))
      .toHaveLength(1);
  });

  it("routes approval, question, and external resolution to the owning runtime", async () => {
    const { provider, handlers } = createHarness();
    const firstEvents: ProviderEvent[] = [];
    const secondEvents: ProviderEvent[] = [];
    const first = provider.createRuntime(runtimeOptions((event) => firstEvents.push(event)));
    const second = provider.createRuntime(runtimeOptions((event) => secondEvents.push(event)));
    first.start();
    second.start();
    first.send("one");
    second.send("two");
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    await vi.waitFor(() => expect(firstEvents).toContainEqual(expect.objectContaining({ type: "session_metadata", sessionId: "thread-1" })));

    const approval = handlers[0]!.onServerRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "item-1",
        command: "pwd", cwd: "/vault", reason: null,
        environmentId: "env", approvalId: null, commandActions: null,
        networkApprovalContext: null, proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    });
    await vi.waitFor(() => expect(firstEvents).toContainEqual(expect.objectContaining({ type: "approval_requested", requestId: "string:approval-1" })));
    expect(secondEvents.some((event) => event.type === "approval_requested")).toBe(false);
    first.respondApproval("string:approval-1", "allow_always");
    await expect(approval).resolves.toEqual({ decision: "acceptForSession" });

    const question = handlers[0]!.onServerRequest({
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-2", turnId: "turn-2", itemId: "item-2",
        autoResolutionMs: null,
        questions: [{ id: "q", header: "Q", question: "Answer?", isOther: false, isSecret: false, options: null }],
      },
    });
    await vi.waitFor(() => expect(secondEvents).toContainEqual(expect.objectContaining({ type: "question_requested", requestId: "string:question-1" })));
    second.respondQuestion("string:question-1", [], { q: "yes" });
    await expect(question).resolves.toEqual({ answers: { q: { answers: ["yes"] } } });

    const external = handlers[0]!.onServerRequest({
      id: "external-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-1", startedAtMs: 1, reason: null, grantRoot: null },
    });
    handlers[0]!.onNotification({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "external-1" } });
    await expect(external).resolves.toBeNull();
    expect(firstEvents).toContainEqual({ type: "request_resolved", requestId: "string:external-1", reason: "server" });
  });

  it("maps permission approvals through the exact owning broker request", async () => {
    const { provider, handlers } = createHarness();
    const runtime = provider.createRuntime(runtimeOptions(() => undefined));
    runtime.start();
    runtime.send("one");
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    await vi.waitFor(() => expect(runtime.ready).toBe(true));

    const pending = handlers[0]!.onServerRequest({
      id: "permissions-1",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "permission-item",
        environmentId: "env", startedAtMs: 1, cwd: "/vault", reason: "Need access",
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ["/shared"], write: ["/shared"], entries: [] },
        },
      },
    });
    runtime.respondApproval("string:permissions-1", "allow_always");
    await expect(pending).resolves.toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/shared"], write: ["/shared"], entries: [] },
      },
      scope: "session",
    });
  });

  it("settles deny for every approval request kind", async () => {
    const { provider, handlers } = createHarness();
    const runtime = provider.createRuntime(runtimeOptions(() => undefined));
    runtime.start();
    runtime.send("one");
    await vi.waitFor(() => expect(runtime.ready).toBe(true));

    const command = handlers[0]!.onServerRequest({
      id: "deny-command",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "command-1",
        command: "pwd", cwd: "/vault", reason: null,
        environmentId: "env", approvalId: null, commandActions: null,
        networkApprovalContext: null, proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    });
    const file = handlers[0]!.onServerRequest({
      id: "deny-file",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
        startedAtMs: 1, reason: null, grantRoot: null,
      },
    });
    const permissions = handlers[0]!.onServerRequest({
      id: "deny-permissions",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "permissions-1",
        environmentId: "env", startedAtMs: 1, cwd: "/vault",
        reason: "Need access",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });

    runtime.respondApproval("string:deny-command", "deny");
    runtime.respondApproval("string:deny-file", "deny");
    runtime.respondApproval("string:deny-permissions", "deny");

    await expect(command).resolves.toEqual({ decision: "decline" });
    await expect(file).resolves.toEqual({ decision: "decline" });
    await expect(permissions).resolves.toEqual({ permissions: {}, scope: "turn" });
  });

  it("propagates unknown server requests as method-not-found", async () => {
    const { provider, handlers } = createHarness();
    const runtime = provider.createRuntime(runtimeOptions(() => undefined));
    runtime.start();
    await vi.waitFor(() => expect(handlers).toHaveLength(1));

    await expect(handlers[0]!.onServerRequest({
      id: 99,
      method: "future/request",
      params: {},
    })).rejects.toMatchObject({ code: -32601 });
  });

  it("cleans runtimes and the shared process idempotently", async () => {
    const process = createProcessController();
    const harness = createHarness();
    (harness.processFactory as ReturnType<typeof vi.fn>).mockResolvedValue(process.process);
    const first = harness.provider.createRuntime(runtimeOptions(() => undefined));
    const second = harness.provider.createRuntime(runtimeOptions(() => undefined));
    first.start();
    second.start();
    await vi.waitFor(() => expect(harness.clientFactory).toHaveBeenCalledTimes(1));

    first.cleanup();
    first.cleanup();
    expect(harness.client.turnInterrupt).not.toHaveBeenCalled();
    expect(second.isRunning()).toBe(true);
    harness.provider.cleanup();
    harness.provider.cleanup();
    await vi.waitFor(() => expect(process.stop).toHaveBeenCalledTimes(1));
    expect(second.isRunning()).toBe(false);
  });

  it("best-effort interrupts an active turn before runtime cleanup unregisters it", async () => {
    const { provider, client } = createHarness();
    const runtime = provider.createRuntime(runtimeOptions(() => undefined));
    runtime.start();
    runtime.send("active");
    await vi.waitFor(() => expect(client.turnStart).toHaveBeenCalledTimes(1));

    runtime.cleanup();
    runtime.cleanup();

    expect(client.turnInterrupt).toHaveBeenCalledTimes(1);
    expect(client.turnInterrupt).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("synchronously cancels all pending server requests owned by a cleaned runtime", async () => {
    const { provider, handlers } = createHarness();
    const runtime = provider.createRuntime(runtimeOptions(() => undefined));
    runtime.start();
    runtime.send("active");
    await vi.waitFor(() => expect(runtime.ready).toBe(true));

    const command = handlers[0]!.onServerRequest({
      id: "cleanup-command",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "command-1",
        command: "pwd", cwd: "/vault", reason: null,
        environmentId: "env", approvalId: null, commandActions: null,
        networkApprovalContext: null, proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    });
    const file = handlers[0]!.onServerRequest({
      id: "cleanup-file",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
        startedAtMs: 1, reason: null, grantRoot: null,
      },
    });
    const permissions = handlers[0]!.onServerRequest({
      id: "cleanup-permissions",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "permissions-1",
        environmentId: "env", startedAtMs: 1, cwd: "/vault",
        reason: "Need access",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    const question = handlers[0]!.onServerRequest({
      id: "cleanup-question",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "question-1",
        autoResolutionMs: null,
        questions: [{
          id: "q", header: "Q", question: "Answer?",
          isOther: false, isSecret: false, options: null,
        }],
      },
    });

    runtime.cleanup();

    await expect(command).resolves.toEqual({ decision: "cancel" });
    await expect(file).resolves.toEqual({ decision: "cancel" });
    await expect(permissions).resolves.toEqual({ permissions: {}, scope: "turn" });
    await expect(question).resolves.toEqual({ answers: {} });
  });

  it("immediately cancels a late approval after its runtime unregisters", async () => {
    const { provider, handlers } = createHarness();
    const runtime = provider.createRuntime(runtimeOptions(() => undefined));
    runtime.start();
    runtime.send("active");
    await vi.waitFor(() => expect(runtime.ready).toBe(true));
    runtime.cleanup();

    const late = handlers[0]!.onServerRequest({
      id: "late-command",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "late-1",
        command: "pwd", cwd: "/vault", reason: null,
        environmentId: "env", approvalId: null, commandActions: null,
        networkApprovalContext: null, proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    });

    await expect(Promise.race([
      late,
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 25)),
    ])).resolves.toEqual({ decision: "cancel" });
  });

  it("stops the shared process once when cleanup races initialization", async () => {
    const process = createProcessController();
    const initialized = deferred<any>();
    const provider = new CodexProvider({
      appVersion: "0.3.0",
      processFactory: async () => process.process,
      clientFactory: async () => initialized.promise,
    });
    const runtime = provider.createRuntime(runtimeOptions(() => undefined));
    runtime.start();
    await vi.waitFor(() => expect(runtime.isRunning()).toBe(true));

    provider.cleanup();
    provider.cleanup();
    initialized.resolve({ client: createHarness().client, dispose: vi.fn() });

    await vi.waitFor(() => expect(process.stop).toHaveBeenCalled());
    expect(process.stop).toHaveBeenCalledTimes(1);
  });

  it("does not assign or register a thread/start result after runtime cleanup", async () => {
    const started = deferred<any>();
    const threadStart = vi.fn(() => started.promise);
    const { provider, clientFactory } = createHarness({ threadStart });
    const runtime = provider.createRuntime(
      runtimeOptions(() => undefined),
    ) as CodexRuntime;
    runtime.start();
    await vi.waitFor(() => expect(threadStart).toHaveBeenCalledTimes(1));
    runtime.cleanup();

    started.resolve({ thread: thread("thread-after-cleanup") });
    await Promise.resolve();
    await Promise.resolve();

    const connection = provider.getActiveConnection()!;
    expect(runtime.threadId).toBeUndefined();
    expect((connection.router as any).runtimes.size).toBe(0);
    expect((provider as any).runtimes.size).toBe(0);
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });

  it("does not register a resumed thread before its RPC succeeds", async () => {
    const resumed = deferred<any>();
    const threadResume = vi.fn(() => resumed.promise);
    const { provider } = createHarness({ threadResume });
    const runtime = provider.createRuntime(runtimeOptions(() => undefined, {
      providerSessionId: "thread-existing",
      resume: true,
    })) as CodexRuntime;
    runtime.start();
    await vi.waitFor(() => expect(threadResume).toHaveBeenCalledTimes(1));

    const connection = provider.getActiveConnection()!;
    expect((connection.router as any).runtimes.size).toBe(0);
    runtime.cleanup();
    resumed.resolve({ thread: thread("thread-existing") });
    await Promise.resolve();
    expect((connection.router as any).runtimes.size).toBe(0);
    expect((provider as any).runtimes.size).toBe(0);
  });
});

describe("CodexProvider services", () => {
  it("lists cwd-scoped interactive sessions across pages and maps history", async () => {
    const threadList = vi.fn()
      .mockResolvedValueOnce({
        data: [thread("thread-1", { name: "Named", preview: "first" })],
        nextCursor: "next",
        backwardsCursor: null,
      })
      .mockResolvedValueOnce({
        data: [thread("thread-2", { name: null, preview: "Fallback title" })],
        nextCursor: null,
        backwardsCursor: null,
      });
    const historyThread = thread("thread-1", {
      turns: [{
        id: "turn-1", status: "completed", error: null, itemsView: "full",
        startedAt: null, completedAt: null, durationMs: null,
        items: [
          { type: "userMessage", id: "u", clientId: null, content: [{ type: "text", text: "hello", text_elements: [] }] },
          { type: "agentMessage", id: "a", text: "hi", phase: null, memoryCitation: null },
        ],
      }],
    });
    const threadRead = vi.fn(async () => ({ thread: historyThread } as never));
    const { provider } = createHarness({ threadList, threadRead });

    await expect(provider.listSessions("/vault")).resolves.toEqual([
      expect.objectContaining({ providerId: "codex", id: "thread-1", title: "Named" }),
      expect.objectContaining({ providerId: "codex", id: "thread-2", title: "Fallback title" }),
    ]);
    expect(threadList).toHaveBeenNthCalledWith(1, {
      cwd: "/vault",
      sourceKinds: ["cli", "vscode", "appServer"],
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    expect(threadList).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "next" }));
    await expect(provider.loadSession("/vault", "thread-1")).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({ role: "assistant", content: "hi" }),
    ]);
    expect(threadRead).toHaveBeenCalledWith({ threadId: "thread-1", includeTurns: true });
  });

  it("maps model effort, skills, rate limits, auth, and login wrappers", async () => {
    const modelList = vi.fn(async () => ({
      data: [{
        id: "catalog-id", model: "gpt-5.4", displayName: "GPT-5.4",
        description: "Best model", hidden: false, isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
        inputModalities: ["text", "image"], supportsPersonality: true,
        upgrade: null, upgradeInfo: null, availabilityNux: null,
        additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null,
      }],
      nextCursor: null,
    } as never));
    const skillsList = vi.fn(async () => ({
      data: [{
        cwd: "/vault", errors: [],
        skills: [{ name: "review", description: "Review code", path: "/skills/review", scope: "user", enabled: true }],
      }],
    } as never));
    const accountRateLimitsRead = vi.fn(async () => ({
      rateLimits: {
        limitId: "codex", limitName: "Codex", planType: null,
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 10 },
        secondary: null, credits: null, individualLimit: null, rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    } as never));
    const accountRead = vi.fn(async () => ({
      account: { type: "chatgpt" as const, email: "dev@example.com", planType: "plus" as never },
      requiresOpenaiAuth: true,
    }));
    const cancelAccountLogin = vi.fn(async () => ({} as never));
    const { provider } = createHarness({
      modelList,
      skillsList,
      accountRateLimitsRead,
      accountRead,
      cancelAccountLogin,
    });

    await expect(provider.listModels()).resolves.toEqual([{
      id: "gpt-5.4", displayName: "GPT-5.4", description: "Best model",
      isDefault: true, defaultEffort: "medium",
      effortOptions: [{ id: "low", description: "Fast" }],
      inputModalities: ["text", "image"], supportsPersonality: true,
    }]);
    await expect(provider.listSkills("/vault")).resolves.toEqual([{
      name: "review", description: "Review code", path: "/skills/review",
      scope: "user", enabled: true, cwd: "/vault",
    }]);
    await expect(provider.getRateLimits()).resolves.toEqual({
      default: {
        id: "codex", name: "Codex",
        primary: { usedPercent: 25, resetsAt: new Date(10_000), windowMinutes: 300 },
        secondary: null,
      },
      byId: {},
    });
    await expect(provider.getAuthState(true)).resolves.toEqual({
      authenticated: true,
      requiresAuth: true,
      accountType: "chatgpt",
      email: "dev@example.com",
      plan: "plus",
    });
    expect(accountRead).toHaveBeenCalledWith({ refreshToken: true });
    await expect(provider.startLogin("browser")).resolves.toEqual({
      type: "browser", loginId: "login", url: "https://login",
    });
    await expect(provider.startLogin("device")).resolves.toEqual({
      type: "device", loginId: "device", url: "https://device", userCode: "CODE",
    });
    await provider.cancelLogin("login");
    expect(cancelAccountLogin).toHaveBeenCalledWith({ loginId: "login" });
    await expect(provider.recoverSession("/vault", "thread-1")).resolves.toMatchObject({
      success: false,
      reason: expect.stringMatching(/do not support/i),
    });
  });
});
