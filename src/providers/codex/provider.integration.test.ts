import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "../types";
import type { CodexAppServerProcess } from "./app-server-process";
import { CodexProvider } from "./provider";

function fakeJsonlAppServer(options: { terminalApproval?: boolean } = {}) {
  const stdout = new PassThrough();
  const requests: Array<{ id?: number | string; method?: string; params?: unknown }> = [];
  const responses: Array<{ id: number | string; result?: unknown }> = [];
  let resolveExit!: (value: any) => void;
  const exit = new Promise<any>((resolve) => {
    resolveExit = resolve;
  });
  const failure = new Promise<any>(() => undefined);
  const stop = vi.fn(async () => {
    const report = { code: 0, signal: null, stderr: "" };
    resolveExit(report);
    return report;
  });

  const respond = (id: number | string, result: unknown) => {
    stdout.write(`${JSON.stringify({ id, result })}\n`);
  };
  const notify = (method: string, params: unknown) => {
    stdout.write(`${JSON.stringify({ method, params })}\n`);
  };

  const process = {
    stdin: {
      write(value: string) {
        const message = JSON.parse(value.trim()) as {
          id?: number | string;
          method?: string;
          params?: unknown;
          result?: unknown;
        };
        requests.push(message);
        if (!message.method && message.id !== undefined) {
          responses.push({ id: message.id, result: message.result });
          return true;
        }
        switch (message.method) {
          case "initialize":
            respond(message.id!, {});
            break;
          case "thread/start":
            respond(message.id!, { thread: { id: "thread-jsonl" } });
            break;
          case "turn/start":
            if (options.terminalApproval) {
              stdout.write(`${JSON.stringify({
                id: "approval-jsonl",
                method: "item/commandExecution/requestApproval",
                params: {
                  threadId: "thread-jsonl",
                  turnId: "turn-jsonl",
                  itemId: "command-jsonl",
                  command: "pwd",
                  cwd: "/vault",
                  reason: null,
                  environmentId: "env",
                  approvalId: null,
                  commandActions: null,
                  networkApprovalContext: null,
                  proposedExecpolicyAmendment: null,
                  proposedNetworkPolicyAmendments: null,
                },
              })}\n`);
              notify("turn/completed", {
                threadId: "thread-jsonl",
                turn: { id: "turn-jsonl", status: "completed", items: [] },
              });
            }
            notify("item/agentMessage/delta", {
              threadId: "thread-jsonl",
              turnId: "turn-jsonl",
              itemId: "agent-jsonl",
              delta: "early JSONL text",
            });
            respond(message.id!, {
              turn: { id: "turn-jsonl", items: [], status: "inProgress" },
            });
            break;
        }
        return true;
      },
      end: vi.fn(),
      on() {
        return this;
      },
    },
    stdout,
    failure,
    exit,
    stop,
  } as unknown as CodexAppServerProcess;

  return { process, requests, responses, stop };
}

describe("CodexProvider JSONL integration", () => {
  it("uses the real transport for handshake, thread start, early routing, and turn start order", async () => {
    const server = fakeJsonlAppServer();
    const provider = new CodexProvider({
      appVersion: "0.3.0",
      processFactory: async () => server.process,
    });
    const events: ProviderEvent[] = [];
    const runtime = provider.createRuntime({
      cwd: "/vault",
      model: "gpt-5.4",
      permissionMode: "manual",
      onEvent: (event) => events.push(event),
    });

    runtime.start();
    runtime.send("hello JSONL");

    await vi.waitFor(() => expect(events).toContainEqual({
      type: "text_delta",
      delta: "early JSONL text",
      itemId: "agent-jsonl",
    }));
    expect(server.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(server.requests[0]?.params).toEqual({
      clientInfo: { name: "hyo", title: "Hyo", version: "0.3.0" },
      capabilities: null,
    });
    expect(server.requests[2]?.params).toEqual({
      cwd: "/vault",
      model: "gpt-5.4",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(server.requests[3]?.params).toEqual({
      threadId: "thread-jsonl",
      input: [{ type: "text", text: "hello JSONL", text_elements: [] }],
    });

    provider.cleanup();
    await vi.waitFor(() => expect(server.stop).toHaveBeenCalledTimes(1));
  });

  it("cancels an early approval when a terminal event precedes the turn/start response", async () => {
    const server = fakeJsonlAppServer({ terminalApproval: true });
    const provider = new CodexProvider({
      appVersion: "0.3.0",
      processFactory: async () => server.process,
    });
    const events: ProviderEvent[] = [];
    const runtime = provider.createRuntime({
      cwd: "/vault",
      model: "gpt-5.4",
      permissionMode: "manual",
      onEvent: (event) => events.push(event),
    });

    runtime.start();
    runtime.send("terminal ordering");

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      status: "completed",
    })));
    await vi.waitFor(() => expect(server.responses).toContainEqual({
      id: "approval-jsonl",
      result: { decision: "cancel" },
    }));
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);

    provider.cleanup();
  });
});
