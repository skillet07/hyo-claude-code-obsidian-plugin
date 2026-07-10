import { describe, expect, it, vi } from "vitest";
import {
  JsonlTransport,
  JsonRpcRemoteError,
  JsonRpcTransportClosedError,
  JsonRpcTimeoutError,
} from "./jsonl-transport";

function createTransport(options: ConstructorParameters<typeof JsonlTransport>[0] = {}) {
  const lines: string[] = [];
  const transport = new JsonlTransport({
    ...options,
    write: (line) => lines.push(line),
  });
  return { lines, transport };
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

  it("rejects every pending request on dispose and refuses new work", async () => {
    const { transport } = createTransport();
    const first = transport.request("first", {});
    const second = transport.request("second", {});

    transport.dispose(new Error("process exited"));

    await expect(first).rejects.toMatchObject({
      name: "JsonRpcTransportClosedError",
      message: "process exited",
    });
    await expect(second).rejects.toBeInstanceOf(JsonRpcTransportClosedError);
    await expect(transport.request("later", {})).rejects.toBeInstanceOf(
      JsonRpcTransportClosedError,
    );
  });
});
