import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "../types";
import type { CodexAppServerProcess } from "./app-server-process";
import { CodexProvider } from "./provider";

function fakeJsonlAppServer() {
  const stdout = new PassThrough();
  const requests: Array<{ id?: number; method: string; params?: unknown }> = [];
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

  const respond = (id: number, result: unknown) => {
    stdout.write(`${JSON.stringify({ id, result })}\n`);
  };
  const notify = (method: string, params: unknown) => {
    stdout.write(`${JSON.stringify({ method, params })}\n`);
  };

  const process = {
    stdin: {
      write(value: string) {
        const message = JSON.parse(value.trim()) as {
          id?: number;
          method: string;
          params?: unknown;
        };
        requests.push(message);
        switch (message.method) {
          case "initialize":
            respond(message.id!, {});
            break;
          case "thread/start":
            respond(message.id!, { thread: { id: "thread-jsonl" } });
            break;
          case "turn/start":
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

  return { process, requests, stop };
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
});
