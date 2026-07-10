import type { RequestId } from "./generated/RequestId";
import { StringDecoder } from "node:string_decoder";

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: RequestId;
}

export interface JsonlTransportOptions {
  write?: (line: string) => void;
  requestTimeoutMs?: number;
  onNotification?: (notification: JsonRpcNotification) => void;
  onServerRequest?: (request: JsonRpcServerRequest) => unknown | Promise<unknown>;
  onMalformedLine?: (line: string, error: Error) => void;
}

export interface JsonRpcRequestOptions {
  id?: RequestId;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResponseMessage {
  id: RequestId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class JsonRpcTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`Codex app-server request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "JsonRpcTimeoutError";
  }
}

export class JsonRpcRemoteError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcRemoteError";
  }
}

export class JsonRpcTransportClosedError extends Error {
  constructor(message = "Codex app-server transport is closed") {
    super(message);
    this.name = "JsonRpcTransportClosedError";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class JsonlTransport {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private disposedError: Error | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly writeLine: (line: string) => void;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: JsonlTransportOptions = {}) {
    this.writeLine = options.write ?? (() => undefined);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  push(chunk: string | Uint8Array): void {
    if (this.disposedError) return;
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim()) this.handleLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  request<T>(
    method: string,
    params: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<T> {
    if (this.disposedError) return Promise.reject(this.disposedError);

    const id = options.id ?? this.nextRequestId++;
    if (this.pending.has(id)) {
      return Promise.reject(
        new Error(`Duplicate Codex app-server request id: ${String(id)}`),
      );
    }

    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });

    try {
      this.write({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(asError(error));
      }
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.disposedError) throw this.disposedError;
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown): void {
    if (this.disposedError) throw this.disposedError;
    this.write({ id, result });
  }

  respondError(
    id: RequestId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    if (this.disposedError) throw this.disposedError;
    this.write({
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    });
  }

  dispose(reason?: Error): void {
    if (this.disposedError) return;
    this.disposedError = reason ?? new JsonRpcTransportClosedError();
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.disposedError);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.options.onMalformedLine?.(line, asError(error));
      return;
    }

    if (!isRecord(message)) {
      this.options.onMalformedLine?.(
        line,
        new Error("JSONL message must be an object"),
      );
      return;
    }

    const hasMethod = hasOwn(message, "method");
    const hasId = hasOwn(message, "id");
    const hasResult = hasOwn(message, "result");
    const hasError = hasOwn(message, "error");

    if (hasMethod) {
      if (typeof message.method !== "string") {
        this.reportMalformed(line, "JSONL message method must be a string");
        return;
      }
      if (hasResult || hasError) {
        this.reportMalformed(
          line,
          "JSONL request or notification cannot contain result or error",
        );
        return;
      }
      if (hasId && !isRequestId(message.id)) {
        this.reportMalformed(line, "JSONL request id must be a string or number");
        return;
      }

      if (hasId) {
        void this.handleServerRequest({
          id: message.id as RequestId,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        });
      } else {
        this.options.onNotification?.({
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        });
      }
      return;
    }

    if (!hasId || !isRequestId(message.id)) {
      this.reportMalformed(line, "JSONL response id must be a string or number");
      return;
    }
    if (hasResult === hasError) {
      this.reportMalformed(
        line,
        "JSONL response must contain exactly one of result or error",
      );
      return;
    }
    if (hasError && !isResponseError(message.error)) {
      this.reportMalformed(
        line,
        "JSONL response error must contain a numeric code and string message",
      );
      return;
    }

    this.handleResponse({
      id: message.id,
      ...(hasResult ? { result: message.result } : {}),
      ...(hasError ? { error: message.error as ResponseMessage["error"] } : {}),
    });
  }

  private handleResponse(response: ResponseMessage): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(
        new JsonRpcRemoteError(
          response.error.code,
          response.error.message,
          response.error.data,
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    try {
      if (!this.options.onServerRequest) {
        this.respondError(
          request.id,
          -32601,
          `No handler for server request "${request.method}"`,
        );
        return;
      }
      this.respond(request.id, await this.options.onServerRequest(request));
    } catch (error) {
      if (!this.disposedError) {
        this.respondError(request.id, -32603, asError(error).message);
      }
    }
  }

  private write(message: object): void {
    this.writeLine(`${JSON.stringify(message)}\n`);
  }

  private reportMalformed(line: string, message: string): void {
    this.options.onMalformedLine?.(line, new Error(message));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

function hasOwn(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function isResponseError(
  value: unknown,
): value is NonNullable<ResponseMessage["error"]> {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    Number.isFinite(value.code) &&
    typeof value.message === "string"
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
