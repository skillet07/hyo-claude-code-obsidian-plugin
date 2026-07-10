import type { InitializeParams } from "./generated/InitializeParams";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { CancelLoginAccountParams } from "./generated/v2/CancelLoginAccountParams";
import type { CancelLoginAccountResponse } from "./generated/v2/CancelLoginAccountResponse";
import type { GetAccountParams } from "./generated/v2/GetAccountParams";
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse";
import type { ModelListParams } from "./generated/v2/ModelListParams";
import type { ModelListResponse } from "./generated/v2/ModelListResponse";
import type { SkillsListParams } from "./generated/v2/SkillsListParams";
import type { SkillsListResponse } from "./generated/v2/SkillsListResponse";
import type { ThreadCompactStartParams } from "./generated/v2/ThreadCompactStartParams";
import type { ThreadCompactStartResponse } from "./generated/v2/ThreadCompactStartResponse";
import type { ThreadListParams } from "./generated/v2/ThreadListParams";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { ThreadSetNameParams } from "./generated/v2/ThreadSetNameParams";
import type { ThreadSetNameResponse } from "./generated/v2/ThreadSetNameResponse";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import type { AppServerExit, CodexAppServerProcess } from "./app-server-process";
import { JsonlTransport, type JsonlTransportOptions } from "./jsonl-transport";

export interface RpcPeer {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
}

export interface HyoClientMetadata {
  version: string;
}

type ChatGptBrowserLoginParams = Omit<
  Extract<LoginAccountParams, { type: "chatgpt" }>,
  "type"
>;

export class CodexAppServerClient {
  constructor(private readonly rpc: RpcPeer) {}

  static async initialize(
    rpc: RpcPeer,
    metadata: HyoClientMetadata,
  ): Promise<CodexAppServerClient> {
    const params: InitializeParams = {
      clientInfo: {
        name: "hyo",
        title: "Hyo",
        version: metadata.version,
      },
      capabilities: null,
    };
    await rpc.request<InitializeResponse>("initialize", params);
    rpc.notify("initialized");
    return new CodexAppServerClient(rpc);
  }

  accountRead(params: GetAccountParams = {}): Promise<GetAccountResponse> {
    return this.rpc.request("account/read", params);
  }

  startChatGptBrowserLogin(
    params: ChatGptBrowserLoginParams = {},
  ): Promise<LoginAccountResponse> {
    return this.rpc.request("account/login/start", { type: "chatgpt", ...params });
  }

  startChatGptDeviceLogin(): Promise<LoginAccountResponse> {
    return this.rpc.request("account/login/start", { type: "chatgptDeviceCode" });
  }

  cancelAccountLogin(
    params: CancelLoginAccountParams,
  ): Promise<CancelLoginAccountResponse> {
    return this.rpc.request("account/login/cancel", params);
  }

  modelList(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.rpc.request("model/list", params);
  }

  skillsList(params: SkillsListParams = {}): Promise<SkillsListResponse> {
    return this.rpc.request("skills/list", params);
  }

  accountRateLimitsRead(): Promise<GetAccountRateLimitsResponse> {
    return this.rpc.request("account/rateLimits/read", undefined);
  }

  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.rpc.request("thread/start", params);
  }

  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.rpc.request("thread/resume", params);
  }

  threadList(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return this.rpc.request("thread/list", params);
  }

  threadRead(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.rpc.request("thread/read", params);
  }

  threadSetName(params: ThreadSetNameParams): Promise<ThreadSetNameResponse> {
    return this.rpc.request("thread/name/set", params);
  }

  threadCompact(
    params: ThreadCompactStartParams,
  ): Promise<ThreadCompactStartResponse> {
    return this.rpc.request("thread/compact/start", params);
  }

  turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.rpc.request("turn/start", params);
  }

  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return this.rpc.request("turn/interrupt", params);
  }
}

export class CodexAppServerExitedError extends Error {
  constructor(public readonly exit: AppServerExit) {
    const status =
      exit.error?.message ??
      (exit.signal ? `signal ${exit.signal}` : `code ${String(exit.code)}`);
    const detail = exit.stderr.trim();
    super(`Codex app-server exited with ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "CodexAppServerExitedError";
  }
}

export function createProcessTransport(
  process: CodexAppServerProcess,
  options: Omit<JsonlTransportOptions, "write"> = {},
): JsonlTransport {
  const transport = new JsonlTransport({
    ...options,
    write: (line) => {
      process.stdin.write(line);
    },
  });
  process.stdout.on("data", (chunk) => transport.push(chunk));
  void process.exit.then((exit) => {
    transport.dispose(new CodexAppServerExitedError(exit));
  });
  return transport;
}
