import { describe, expect, it, vi } from "vitest";
import {
  JsonlTransport,
  JsonRpcRemoteError,
  JsonRpcTransportClosedError,
  JsonRpcTimeoutError,
} from "./jsonl-transport";
import { CodexServerRequestBroker } from "./server-request-broker";

function createTransport(options: ConstructorParameters<typeof JsonlTransport>[0] = {}) {
  const lines: string[] = [];
  const transport = new JsonlTransport({
    ...options,
    write: (line) => lines.push(line),
  });
  return { lines, transport };
}

function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("JsonlTransport", () => {
  it("parses fragmented and coalesced newline-delimited messages", () => {
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const { transport } = createTransport({
      onNotification: (notification) => notifications.push(notification),
    });

    transport.push('{"method":"first","params":{"va');
    transport.push('lue":1}}\n{"jsonrpc":"2.0","method":"second"}\n');

    expect(notifications).toEqual([
      { method: "first", params: { value: 1 } },
      { method: "second" },
    ]);
  });

  it("preserves UTF-8 characters fragmented across byte chunks", () => {
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const { transport } = createTransport({
      onNotification: (notification) => notifications.push(notification),
    });
    const bytes = Buffer.from('{"method":"text","params":{"value":"🙂"}}\n');
    const emojiStart = bytes.indexOf(Buffer.from("🙂"));

    transport.push(bytes.subarray(0, emojiStart + 2));
    transport.push(bytes.subarray(emojiStart + 2));

    expect(notifications).toEqual([
      { method: "text", params: { value: "🙂" } },
    ]);
  });

  it("reports malformed lines and continues parsing later messages", () => {
    const malformed: Array<{ line: string; error: Error }> = [];
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const { transport } = createTransport({
      onMalformedLine: (line, error) => malformed.push({ line, error }),
      onNotification: (notification) => notifications.push(notification),
    });

    transport.push('not json\n{"method":"ready","params":{}}\n');

    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.line).toBe("not json");
    expect(malformed[0]?.error).toBeInstanceOf(Error);
    expect(notifications).toEqual([{ method: "ready", params: {} }]);
  });

  it("reports a response with no result or error without settling its request", async () => {
    vi.useFakeTimers();
    const malformed: Array<{ line: string; error: Error }> = [];
    const { transport } = createTransport({
      requestTimeoutMs: 25,
      onMalformedLine: (line, error) => malformed.push({ line, error }),
    });
    const pending = transport.request("thread/list", {}, { id: 1 });
    const error = captureError(pending);

    transport.push('{"id":1}\n');

    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.line).toBe('{"id":1}');
    await vi.advanceTimersByTimeAsync(25);
    expect(await error).toBeInstanceOf(JsonRpcTimeoutError);
    vi.useRealTimers();
  });

  it("reports a non-string method without settling a matching request", async () => {
    vi.useFakeTimers();
    const malformed: Array<{ line: string; error: Error }> = [];
    const { transport } = createTransport({
      requestTimeoutMs: 25,
      onMalformedLine: (line, error) => malformed.push({ line, error }),
    });
    const pending = transport.request("thread/list", {}, { id: 1 });
    const error = captureError(pending);

    transport.push('{"id":1,"method":42}\n');

    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.line).toBe('{"id":1,"method":42}');
    await vi.advanceTimersByTimeAsync(25);
    expect(await error).toBeInstanceOf(JsonRpcTimeoutError);
    vi.useRealTimers();
  });

  it("reports a method-bearing response without settling its request", async () => {
    vi.useFakeTimers();
    const malformed: string[] = [];
    const { transport } = createTransport({
      requestTimeoutMs: 25,
      onMalformedLine: (line) => malformed.push(line),
    });
    const pending = transport.request("thread/list", {}, { id: 1 });
    const error = captureError(pending);

    transport.push('{"id":1,"method":"thread/list","result":[]}\n');

    expect(malformed).toEqual([
      '{"id":1,"method":"thread/list","result":[]}',
    ]);
    await vi.advanceTimersByTimeAsync(25);
    expect(await error).toBeInstanceOf(JsonRpcTimeoutError);
    vi.useRealTimers();
  });

  it("reports responses with both result and error or an unusable error", async () => {
    vi.useFakeTimers();
    const malformed: string[] = [];
    const { transport } = createTransport({
      requestTimeoutMs: 25,
      onMalformedLine: (line) => malformed.push(line),
    });
    const first = transport.request("first", {}, { id: 1 });
    const second = transport.request("second", {}, { id: 2 });
    const firstError = captureError(first);
    const secondError = captureError(second);

    transport.push(
      '{"id":1,"result":"ok","error":{"code":-1,"message":"bad"}}\n' +
        '{"id":2,"error":{"code":"bad","message":42}}\n',
    );

    expect(malformed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(25);
    expect(await firstError).toBeInstanceOf(JsonRpcTimeoutError);
    expect(await secondError).toBeInstanceOf(JsonRpcTimeoutError);
    vi.useRealTimers();
  });

  it("correlates numeric and string response IDs without collisions", async () => {
    const { lines, transport } = createTransport();
    const numeric = transport.request("numeric", {}, { id: 1 });
    const string = transport.request("string", {}, { id: "1" });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { id: 1, method: "numeric", params: {} },
      { id: "1", method: "string", params: {} },
    ]);

    transport.push('{"jsonrpc":"2.0","id":"1","result":"string result"}\n');
    transport.push('{"id":1,"result":"numeric result"}\n');

    await expect(string).resolves.toBe("string result");
    await expect(numeric).resolves.toBe("numeric result");
  });

  it("rejects a correlated remote error", async () => {
    const { transport } = createTransport();
    const result = transport.request("fails", {}, { id: 7 });

    transport.push(
      '{"id":7,"error":{"code":-32000,"message":"broken","data":{"retry":false}}}\n',
    );

    await expect(result).rejects.toMatchObject({
      code: -32000,
      message: "broken",
      data: { retry: false },
    });
  });

  it("times requests out using the configured timeout", async () => {
    vi.useFakeTimers();
    const { transport } = createTransport({ requestTimeoutMs: 25 });
    const result = transport.request("slow", {});
    const rejection = expect(result).rejects.toBeInstanceOf(JsonRpcTimeoutError);

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    vi.useRealTimers();
  });

  it("handles server-initiated requests and writes matching responses", async () => {
    const { lines, transport } = createTransport({
      onServerRequest: async (request) => ({ approved: request.params }),
    });

    transport.push(
      '{"jsonrpc":"2.0","id":"approval-1","method":"approve","params":{"scope":"file"}}\n',
    );
    await vi.waitFor(() => expect(lines).toHaveLength(1));

    expect(JSON.parse(lines[0]!)).toEqual({
      id: "approval-1",
      result: { approved: { scope: "file" } },
    });
  });

  it("serializes an undefined server-request result as null", async () => {
    const { lines, transport } = createTransport({
      onServerRequest: () => undefined,
    });

    transport.push('{"id":"request-1","method":"approval","params":{}}\n');
    await vi.waitFor(() => expect(lines).toHaveLength(1));

    expect(JSON.parse(lines[0]!)).toEqual({ id: "request-1", result: null });
  });

  it("writes an error response when a server request handler fails", async () => {
    const { lines, transport } = createTransport({
      onServerRequest: () => {
        throw new Error("denied");
      },
    });

    transport.push('{"id":2,"method":"approve","params":{}}\n');
    await vi.waitFor(() => expect(lines).toHaveLength(1));

    expect(JSON.parse(lines[0]!)).toEqual({
      id: 2,
      error: { code: -32603, message: "denied" },
    });
  });

  it("writes method-not-found for an unknown brokered server request", async () => {
    const broker = new CodexServerRequestBroker(() => undefined);
    const { lines, transport } = createTransport({
      onServerRequest: (request) => broker.handle(request as never),
    });

    transport.push('{"id":99,"method":"future/request","params":{}}\n');
    await vi.waitFor(() => expect(lines).toHaveLength(1));

    expect(JSON.parse(lines[0]!)).toEqual({
      id: 99,
      error: {
        code: -32601,
        message: 'No handler for server request "future/request"',
      },
    });
  });

  it("preserves an Error reason when rejecting pending and later work", async () => {
    const { transport } = createTransport();
    const first = transport.request("first", {});
    const second = transport.request("second", {});
    const firstError = captureError(first);
    const secondError = captureError(second);
    const reason = new Error("process exited");

    transport.dispose(reason);

    expect(await firstError).toBe(reason);
    expect(await secondError).toBe(reason);
    expect(await captureError(transport.request("later", {}))).toBe(reason);
  });

  it("uses a closed error when disposed without a reason", async () => {
    const { transport } = createTransport();
    const pending = transport.request("pending", {});
    const error = captureError(pending);

    transport.dispose();

    expect(await error).toBeInstanceOf(JsonRpcTransportClosedError);
  });
});
