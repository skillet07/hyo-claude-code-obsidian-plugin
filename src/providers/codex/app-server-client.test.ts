import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerProcess } from "./app-server-process";
import {
  CodexAppServerClient,
  CodexAppServerExitedError,
  createProcessTransport,
  type RpcPeer,
} from "./app-server-client";

function createRpc(results: unknown[] = []): {
  calls: Array<{ kind: "request" | "notify"; method: string; params?: unknown }>;
  rpc: RpcPeer;
} {
  const calls: Array<{
    kind: "request" | "notify";
    method: string;
    params?: unknown;
  }> = [];
  return {
    calls,
    rpc: {
      request: async <T>(method: string, params?: unknown) => {
        calls.push({ kind: "request", method, params });
        return results.shift() as T;
      },
      notify: (method, params) => calls.push({ kind: "notify", method, params }),
    },
  };
}

describe("CodexAppServerClient", () => {
  it("performs initialize then initialized with stable Hyo metadata", async () => {
    const { calls, rpc } = createRpc([{}]);

    await CodexAppServerClient.initialize(rpc, { version: "0.3.0" });

    expect(calls).toEqual([
      {
        kind: "request",
        method: "initialize",
        params: {
          clientInfo: { name: "hyo", title: "Hyo", version: "0.3.0" },
          capabilities: null,
        },
      },
      { kind: "notify", method: "initialized", params: undefined },
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(
        (calls[0]!.params as { capabilities: object }).capabilities ?? {},
        "experimentalApi",
      ),
    ).toBe(false);
  });

  it("delegates stable wrapper methods with exact method names and params", async () => {
    const { calls, rpc } = createRpc(Array.from({ length: 15 }, () => ({})));
    const client = new CodexAppServerClient(rpc);

    await client.accountRead({ refreshToken: true });
    await client.startChatGptBrowserLogin({ useHostedLoginSuccessPage: true });
    await client.startChatGptDeviceLogin();
    await client.cancelAccountLogin({ loginId: "login-1" });
    await client.modelList({ includeHidden: true });
    await client.skillsList({ cwds: ["/vault"], forceReload: true });
    await client.accountRateLimitsRead();
    await client.threadStart({ cwd: "/vault", model: "gpt-5.4" });
    await client.threadResume({ threadId: "thread-1" });
    await client.threadList({ limit: 20 });
    await client.threadRead({ threadId: "thread-1", includeTurns: true });
    await client.threadSetName({ threadId: "thread-1", name: "New name" });
    await client.threadCompact({ threadId: "thread-1" });
    await client.turnStart({ threadId: "thread-1", input: [] });
    await client.turnInterrupt({ threadId: "thread-1", turnId: "turn-1" });

    expect(calls).toEqual([
      { kind: "request", method: "account/read", params: { refreshToken: true } },
      {
        kind: "request",
        method: "account/login/start",
        params: { type: "chatgpt", useHostedLoginSuccessPage: true },
      },
      {
        kind: "request",
        method: "account/login/start",
        params: { type: "chatgptDeviceCode" },
      },
      {
        kind: "request",
        method: "account/login/cancel",
        params: { loginId: "login-1" },
      },
      { kind: "request", method: "model/list", params: { includeHidden: true } },
      {
        kind: "request",
        method: "skills/list",
        params: { cwds: ["/vault"], forceReload: true },
      },
      { kind: "request", method: "account/rateLimits/read", params: undefined },
      {
        kind: "request",
        method: "thread/start",
        params: { cwd: "/vault", model: "gpt-5.4" },
      },
      { kind: "request", method: "thread/resume", params: { threadId: "thread-1" } },
      { kind: "request", method: "thread/list", params: { limit: 20 } },
      {
        kind: "request",
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
      {
        kind: "request",
        method: "thread/name/set",
        params: { threadId: "thread-1", name: "New name" },
      },
      {
        kind: "request",
        method: "thread/compact/start",
        params: { threadId: "thread-1" },
      },
      {
        kind: "request",
        method: "turn/start",
        params: { threadId: "thread-1", input: [] },
      },
      {
        kind: "request",
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      },
    ]);
  });

  it("rejects pending transport work when the process exits", async () => {
    const stdout = new PassThrough();
    const writes: string[] = [];
    let resolveExit!: (value: Awaited<CodexAppServerProcess["exit"]>) => void;
    const process: CodexAppServerProcess = {
      stdin: {
        write: (value) => {
          writes.push(value);
          return true;
        },
        end: vi.fn(),
        on() {
          return this;
        },
      },
      stdout,
      exit: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      stop: vi.fn(),
    };
    const transport = createProcessTransport(process);
    const pending = transport.request("thread/list", {});
    const rejection = pending.catch((error: unknown) => error);
    const exit = { code: 9, signal: null, stderr: "fatal stderr" } as const;

    resolveExit(exit);

    const error = await rejection;
    expect(error).toBeInstanceOf(CodexAppServerExitedError);
    expect(error).toMatchObject({ exit });
    expect(writes).toHaveLength(1);
  });
});
