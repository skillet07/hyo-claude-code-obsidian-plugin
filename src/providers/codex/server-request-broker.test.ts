import { describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "../types";
import {
  CodexServerRequestBroker,
  JsonRpcMethodNotFoundError,
} from "./server-request-broker";

function createBroker() {
  const events: ProviderEvent[] = [];
  return {
    events,
    broker: new CodexServerRequestBroker((event) => events.push(event)),
  };
}

const uiRequestId = (requestId: string | number) => `${typeof requestId}:${requestId}`;

const commandRequest = {
  method: "item/commandExecution/requestApproval" as const,
  id: 41,
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "cmd-1",
    startedAtMs: 1,
    approvalId: "approval-1",
    environmentId: "env-1",
    reason: "Needs network",
    networkApprovalContext: { host: "example.com", protocol: "https" as const },
    command: "curl https://example.com",
    cwd: "/vault",
    commandActions: [],
    proposedExecpolicyAmendment: ["prefix_rule", "curl"],
    proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" as const }],
  },
};

describe("CodexServerRequestBroker", () => {
  it("keeps concurrent numeric and string JSON-RPC ids independent", async () => {
    const { broker, events } = createBroker();
    const numeric = broker.handle({ ...commandRequest, id: 1 });
    const string = broker.handle({
      method: "item/fileChange/requestApproval",
      id: "1",
      params: {
        threadId: "thread-2", turnId: "turn-2", itemId: "file-2",
        startedAtMs: 2, reason: null, grantRoot: null,
      },
    });

    expect(events.map((event) => "requestId" in event ? event.requestId : null)).toEqual([
      "number:1",
      "string:1",
    ]);
    expect(broker.pendingCount).toBe(2);

    expect(broker.respondApproval("string:1", { decision: "deny" })).toBe(true);
    expect(broker.respondApproval("number:1", { decision: "allow" })).toBe(true);
    await expect(string).resolves.toEqual({ decision: "decline" });
    await expect(numeric).resolves.toEqual({ decision: "accept" });
  });

  it("rolls back maps and auto-resolution timer when UI delivery throws", async () => {
    vi.useFakeTimers();
    const broker = new CodexServerRequestBroker(() => {
      throw new Error("UI unavailable");
    });

    const pending = broker.handle({
      method: "item/tool/requestUserInput",
      id: "throwing-question",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "question-item",
        autoResolutionMs: 100,
        questions: [{ id: "q", header: "Q", question: "Answer?", isOther: false, isSecret: false, options: null }],
      },
    });

    await expect(pending).rejects.toThrow("UI unavailable");
    expect(broker.pendingCount).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(broker.pendingCount).toBe(0);
    expect(broker.respondQuestion(uiRequestId("throwing-question"), { q: "late" })).toBe(false);
    vi.useRealTimers();
  });

  it("contains a request-resolved callback error during auto-resolution", async () => {
    vi.useFakeTimers();
    const broker = new CodexServerRequestBroker((event) => {
      if (event.type === "request_resolved") throw new Error("terminal UI failed");
    });
    const pending = broker.handle({
      method: "item/tool/requestUserInput",
      id: "auto-terminal-throw",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "question-item",
        autoResolutionMs: 100,
        questions: [{ id: "q", header: "Q", question: "Answer?", isOther: false, isSecret: false, options: null }],
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeNull();
    expect(broker.pendingCount).toBe(0);
    vi.useRealTimers();
  });

  it("drains every pending request during dispose when terminal callbacks throw", async () => {
    const broker = new CodexServerRequestBroker((event) => {
      if (event.type === "request_resolved") throw new Error("terminal UI failed");
    });
    const first = broker.handle({ ...commandRequest, id: "dispose-one" });
    const second = broker.handle({
      method: "item/fileChange/requestApproval",
      id: "dispose-two",
      params: {
        threadId: "thread-2", turnId: "turn-2", itemId: "file-2",
        startedAtMs: 2, reason: null, grantRoot: null,
      },
    });

    expect(() => broker.dispose()).not.toThrow();
    expect(broker.pendingCount).toBe(0);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
  });

  it("rejects a duplicate typed request id before emitting another prompt", async () => {
    const { broker, events } = createBroker();
    const first = broker.handle({ ...commandRequest, id: 7 });

    const duplicate = broker.handle({
      method: "item/fileChange/requestApproval",
      id: 7,
      params: {
        threadId: "thread-2", turnId: "turn-2", itemId: "file-2",
        startedAtMs: 2, reason: null, grantRoot: null,
      },
    });

    await expect(duplicate).rejects.toThrow("Duplicate Codex server request id: number:7");
    expect(events).toHaveLength(1);
    expect(broker.pendingCount).toBe(1);
    broker.respondApproval(uiRequestId(7), { decision: "cancel" });
    await expect(first).resolves.toEqual({ decision: "cancel" });
  });

  it("emits command approval context and waits for the future runtime response", async () => {
    const { broker, events } = createBroker();
    const pending = broker.handle(commandRequest);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(events).toEqual([{
      type: "approval_requested",
      requestId: uiRequestId(41),
      toolName: "command",
      approvalKind: "command_execution",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      reason: "Needs network",
      input: {
        command: "curl https://example.com",
        cwd: "/vault",
        environmentId: "env-1",
        approvalId: "approval-1",
        commandActions: [],
        networkApprovalContext: { host: "example.com", protocol: "https" },
      },
      availableDecisions: [
        "allow", "allow_session", "allow_execpolicy_amendment",
        "apply_network_policy_amendment", "deny", "cancel",
      ],
      proposedAmendments: {
        execpolicy: ["prefix_rule", "curl"],
        networkPolicy: [{ host: "example.com", action: "allow" }],
      },
    }]);

    expect(broker.respondApproval(uiRequestId(41), { decision: "allow" })).toBe(true);
    await expect(pending).resolves.toEqual({ decision: "accept" });
  });

  it.each([
    [{ decision: "allow_session" } as const, { decision: "acceptForSession" }],
    [
      { decision: "allow_execpolicy_amendment", execpolicyAmendment: ["prefix_rule", "git", "status"] as string[] } as const,
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["prefix_rule", "git", "status"] } } },
    ],
    [
      { decision: "apply_network_policy_amendment", networkPolicyAmendment: { host: "example.com", action: "allow" as const } } as const,
      { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } } },
    ],
    [{ decision: "deny" } as const, { decision: "decline" }],
    [{ decision: "cancel" } as const, { decision: "cancel" }],
  ])("maps command approval response %# to the exact generated shape", async (response, expected) => {
    const { broker } = createBroker();
    const pending = broker.handle({ ...commandRequest, id: `command-${response.decision}` });
    broker.respondApproval(uiRequestId(`command-${response.decision}`), response);
    await expect(pending).resolves.toEqual(expected);
  });

  it.each([
    ["allow", "accept"],
    ["allow_session", "acceptForSession"],
    ["deny", "decline"],
    ["cancel", "cancel"],
  ] as const)("maps file-change %s to %s", async (decision, wireDecision) => {
    const { broker, events } = createBroker();
    const pending = broker.handle({
      method: "item/fileChange/requestApproval",
      id: `file-${decision}`,
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
        startedAtMs: 1, reason: "Write outside vault", grantRoot: "/shared",
      },
    });
    expect(events[0]).toEqual({
      type: "approval_requested", requestId: uiRequestId(`file-${decision}`),
      toolName: "file change", approvalKind: "file_change",
      threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
      reason: "Write outside vault", input: { grantRoot: "/shared" },
      availableDecisions: ["allow", "allow_session", "deny", "cancel"],
    });
    broker.respondApproval(uiRequestId(`file-${decision}`), { decision });
    await expect(pending).resolves.toEqual({ decision: wireDecision });
  });

  it("keeps a file approval pending after an incompatible amendment response", async () => {
    const { broker } = createBroker();
    const pending = broker.handle({
      method: "item/fileChange/requestApproval",
      id: "file-pending",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
        startedAtMs: 1, reason: null, grantRoot: null,
      },
    });

    expect(broker.respondApproval(uiRequestId("file-pending"), {
      decision: "allow_execpolicy_amendment", execpolicyAmendment: ["prefix_rule", "git"],
    })).toBe(false);
    expect(broker.pendingCount).toBe(1);
    expect(broker.respondApproval(uiRequestId("file-pending"), { decision: "allow" })).toBe(true);
    await expect(pending).resolves.toEqual({ decision: "accept" });
  });

  it.each(["turn", "session"] as const)(
    "maps requested permissions with %s grant scope",
    async (scope) => {
      const { broker, events } = createBroker();
      const permissions = {
        network: { enabled: true },
        fileSystem: { read: ["/shared"], write: ["/shared"], entries: [] },
      };
      const pending = broker.handle({
        method: "item/permissions/requestApproval",
        id: `permissions-${scope}`,
        params: {
          threadId: "thread-1", turnId: "turn-1", itemId: "permissions-1",
          environmentId: "env-1", startedAtMs: 1, cwd: "/vault",
          reason: "Need shared files", permissions,
        },
      });
      expect(events[0]).toEqual({
        type: "approval_requested", requestId: uiRequestId(`permissions-${scope}`),
        toolName: "permissions", approvalKind: "permissions",
        threadId: "thread-1", turnId: "turn-1", itemId: "permissions-1",
        reason: "Need shared files",
        input: { cwd: "/vault", environmentId: "env-1", permissions },
        availableDecisions: ["allow", "allow_session", "deny"],
        grantScopes: ["turn", "session"],
      });
      expect(broker.respondPermissions(uiRequestId(`permissions-${scope}`), {
        permissions: { network: { enabled: true } }, scope, strictAutoReview: true,
      })).toBe(true);
      await expect(pending).resolves.toEqual({
        permissions: { network: { enabled: true } }, scope, strictAutoReview: true,
      });
    },
  );

  it("preserves question ids/options and maps answers by id", async () => {
    const { broker, events } = createBroker();
    const pending = broker.handle({
      method: "item/tool/requestUserInput",
      id: "question-1",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "question-item",
        autoResolutionMs: 5000,
        questions: [{
          id: "choice", header: "Pick", question: "Choose one", isOther: true, isSecret: false,
          options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
        }],
      },
    });
    expect(events).toEqual([{
      type: "question_requested", requestId: uiRequestId("question-1"),
      threadId: "thread-1", turnId: "turn-1", itemId: "question-item",
      autoResolutionMs: 5000,
      questions: [{
        id: "choice", header: "Pick", question: "Choose one",
        isOther: true, isSecret: false,
        options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
      }],
    }]);
    expect(broker.respondQuestion(uiRequestId("question-1"), { choice: ["B"], note: "custom" })).toBe(true);
    await expect(pending).resolves.toEqual({
      answers: { choice: { answers: ["B"] }, note: { answers: ["custom"] } },
    });
  });

  it("cleans up an auto-resolving question and makes a late answer a no-op", async () => {
    vi.useFakeTimers();
    const { broker, events } = createBroker();
    const pending = broker.handle({
      method: "item/tool/requestUserInput",
      id: "auto-question",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "question-item",
        autoResolutionMs: 100,
        questions: [{ id: "q", header: "Q", question: "Answer?", isOther: false, isSecret: false, options: null }],
      },
    });

    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toBeNull();
    expect(broker.pendingCount).toBe(0);
    expect(events.at(-1)).toEqual({ type: "request_resolved", requestId: uiRequestId("auto-question"), reason: "auto" });
    expect(broker.respondQuestion(uiRequestId("auto-question"), { q: "late" })).toBe(false);
    vi.useRealTimers();
  });

  it("dismisses server-resolved UI and ignores an answer after resolution", async () => {
    const { broker, events } = createBroker();
    const pending = broker.handle({
      method: "item/fileChange/requestApproval",
      id: "resolved-file",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "file-1",
        startedAtMs: 1, reason: null, grantRoot: null,
      },
    });

    expect(broker.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "resolved-file" },
    })).toBe(true);

    await expect(pending).resolves.toBeNull();
    expect(events.at(-1)).toEqual({ type: "request_resolved", requestId: uiRequestId("resolved-file"), reason: "server" });
    expect(broker.respondApproval(uiRequestId("resolved-file"), { decision: "allow" })).toBe(false);
  });

  it("rejects unknown server requests with a method-not-found error", async () => {
    const { broker } = createBroker();
    await expect(broker.handle({ method: "future/request", id: 99, params: {} } as never))
      .rejects.toEqual(expect.objectContaining({
        name: "JsonRpcMethodNotFoundError", code: -32601,
        message: 'No handler for server request "future/request"',
      } satisfies Partial<JsonRpcMethodNotFoundError>));
  });
});
