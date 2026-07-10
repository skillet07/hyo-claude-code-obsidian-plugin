import type {
  ChatProvider,
  ProviderApprovalBehavior,
  ProviderAuthState,
  ProviderCapabilities,
  ProviderEvent,
  ProviderHistoryMessage,
  ProviderLoginMethod,
  ProviderLoginStartResult,
  ProviderModelInfo,
  ProviderQuestion,
  ProviderRateLimitInfo,
  ProviderRateLimits,
  ProviderRecoveryResult,
  ProviderRuntime,
  ProviderRuntimeOptions,
  ProviderSessionSummary,
  ProviderSkillInfo,
} from "../types";
import {
  CodexAppServerClient,
  createProcessTransport,
} from "./app-server-client";
import {
  spawnCodexAppServer,
  type AppServerExit,
  type CodexAppServerProcess,
} from "./app-server-process";
import type { JsonRpcNotification, JsonRpcServerRequest } from "./jsonl-transport";
import {
  CODEX_ROUTER_DEFAULTS,
  CodexNotificationRouter,
} from "./notification-router";
import {
  CodexServerRequestBroker,
  type ProviderApprovalResponse,
} from "./server-request-broker";
import { convertProviderInput } from "./input-converter";
import { mapThreadHistory, mapThreadSummary } from "./history-mapper";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { ModelListResponse } from "./generated/v2/ModelListResponse";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot";
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
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse";
import type { CancelLoginAccountResponse } from "./generated/v2/CancelLoginAccountResponse";

export interface CodexProviderClient {
  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse>;
  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
  threadList(params?: ThreadListParams): Promise<ThreadListResponse>;
  threadRead(params: ThreadReadParams): Promise<ThreadReadResponse>;
  threadSetName(params: ThreadSetNameParams): Promise<ThreadSetNameResponse>;
  threadCompact(params: ThreadCompactStartParams): Promise<ThreadCompactStartResponse>;
  turnStart(params: TurnStartParams): Promise<TurnStartResponse>;
  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse>;
  modelList(params?: Parameters<CodexAppServerClient["modelList"]>[0]): Promise<ModelListResponse>;
  skillsList(params?: Parameters<CodexAppServerClient["skillsList"]>[0]): Promise<SkillsListResponse>;
  accountRateLimitsRead(): Promise<GetAccountRateLimitsResponse>;
  accountRead(params?: Parameters<CodexAppServerClient["accountRead"]>[0]): Promise<GetAccountResponse>;
  startChatGptBrowserLogin(params?: Parameters<CodexAppServerClient["startChatGptBrowserLogin"]>[0]): Promise<LoginAccountResponse>;
  startChatGptDeviceLogin(): Promise<LoginAccountResponse>;
  cancelAccountLogin(params: { loginId: string }): Promise<CancelLoginAccountResponse>;
}

export interface CodexConnectionHandlers {
  onNotification(notification: JsonRpcNotification): void;
  onServerRequest(request: JsonRpcServerRequest): Promise<unknown>;
}

export interface CodexClientConnection {
  client: CodexProviderClient;
  dispose(): void;
}

export type CodexClientFactory = (
  process: CodexAppServerProcess,
  handlers: CodexConnectionHandlers,
  metadata: { version: string },
) => Promise<CodexClientConnection>;

export interface CodexProviderOptions {
  appVersion: string;
  command?: string;
  processFactory?: () => Promise<CodexAppServerProcess>;
  clientFactory?: CodexClientFactory;
}

const CODEX_CAPABILITIES: ProviderCapabilities = {
  approvals: true,
  questions: true,
  planReview: false,
  agents: true,
  sessionHistory: true,
  sessionRename: true,
  compaction: true,
  recovery: false,
  tokenUsage: true,
  models: true,
  skills: true,
  rateLimits: true,
  auth: true,
};

interface ActiveConnection {
  generation: number;
  process: CodexAppServerProcess;
  client: CodexProviderClient;
  disposeClient: () => void;
  router: CodexNotificationRouter;
  broker: CodexServerRequestBroker;
  requestRouter: CodexBrokerRequestRouter;
  requestOwners: Map<string, PendingRequestOwner>;
  stopping: boolean;
  failed: boolean;
}

interface PendingRequestOwner {
  runtimeId: string;
  approvalKind?: "command_execution" | "file_change" | "permissions";
  permissions?: Record<string, unknown>;
}

type BrokerRequestEvent =
  | Extract<ProviderEvent, { type: "approval_requested" }>
  | Extract<ProviderEvent, { type: "question_requested" }>;

interface BufferedBrokerRequest {
  sequence: number;
  event: BrokerRequestEvent;
  candidateRuntimeIds: Set<string>;
  expiresAt: number;
}

class CodexBrokerRequestRouter {
  private readonly turnOwners = new Map<string, string>();
  private readonly bufferedByTurn = new Map<string, BufferedBrokerRequest[]>();
  private readonly retiredTurns = new Map<string, unknown>();
  private bufferedTotal = 0;
  private sequence = 0;
  private expiryTimer: unknown;

  constructor(
    private readonly generation: number,
    private readonly broker: CodexServerRequestBroker,
    private readonly requestOwners: Map<string, PendingRequestOwner>,
    private readonly getRuntimes: () => Iterable<CodexRuntime>,
    private readonly getRuntime: (runtimeId: string) => CodexRuntime | undefined,
  ) {}

  route(event: BrokerRequestEvent): void {
    this.pruneExpired();
    const { threadId, turnId } = event;
    if (!threadId || !turnId) {
      this.broker.cancelRequest(event.requestId);
      return;
    }
    const key = turnKey(threadId, turnId);
    if (this.retiredTurns.has(key)) {
      this.broker.cancelRequest(event.requestId);
      return;
    }
    const ownerId = this.turnOwners.get(key);
    const owner = ownerId ? this.getRuntime(ownerId) : undefined;
    if (owner) {
      this.deliver(owner, event);
      return;
    }

    const candidateRuntimeIds = new Set(
      [...this.getRuntimes()]
        .filter((runtime) =>
          runtime.threadId === threadId &&
          runtime.isAwaitingTurn(this.generation),
        )
        .map((runtime) => runtime.runtimeId),
    );
    if (candidateRuntimeIds.size === 0) {
      this.broker.cancelRequest(event.requestId);
      return;
    }
    this.buffer({
      sequence: this.sequence++,
      event,
      candidateRuntimeIds,
      expiresAt: Date.now() + CODEX_ROUTER_DEFAULTS.bufferTtlMs,
    });
  }

  bind(runtime: CodexRuntime, turnId: string): boolean {
    const threadId = runtime.threadId;
    if (!threadId) return false;
    const key = turnKey(threadId, turnId);
    if (this.retiredTurns.has(key)) return false;
    this.turnOwners.set(key, runtime.runtimeId);
    const buffered = this.bufferedByTurn.get(key) ?? [];
    this.bufferedByTurn.delete(key);
    for (const entry of buffered.sort((left, right) => left.sequence - right.sequence)) {
      this.bufferedTotal--;
      if (entry.candidateRuntimeIds.has(runtime.runtimeId)) {
        this.deliver(runtime, entry.event);
      } else {
        this.broker.cancelRequest(entry.event.requestId);
      }
    }
    this.removeCandidate(runtime.runtimeId);
    this.scheduleExpiry();
    return true;
  }

  failPending(runtime: CodexRuntime): void {
    this.removeCandidate(runtime.runtimeId);
  }

  forgetRequest(requestId: string): void {
    for (const [key, entries] of this.bufferedByTurn) {
      const keep = entries.filter((entry) => {
        if (entry.event.requestId !== requestId) return true;
        this.bufferedTotal--;
        return false;
      });
      if (keep.length === 0) this.bufferedByTurn.delete(key);
      else this.bufferedByTurn.set(key, keep);
    }
    this.scheduleExpiry();
  }

  cleanupRuntime(runtime: CodexRuntime): void {
    this.removeCandidate(runtime.runtimeId);
    for (const [key, ownerId] of [...this.turnOwners]) {
      if (ownerId !== runtime.runtimeId) continue;
      const [threadId, turnId] = splitTurnKey(key);
      this.turnOwners.delete(key);
      this.broker.cancelTurn(threadId, turnId);
      this.retire(key);
    }
  }

  retireRuntimeTurn(runtime: CodexRuntime, turnId: string): void {
    const threadId = runtime.threadId;
    if (!threadId) return;
    const key = turnKey(threadId, turnId);
    if (this.turnOwners.get(key) !== runtime.runtimeId) return;
    this.turnOwners.delete(key);
    this.broker.cancelTurn(threadId, turnId);
    this.retire(key);
  }

  dispose(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer as ReturnType<typeof setTimeout>);
    this.expiryTimer = undefined;
    for (const timer of this.retiredTurns.values()) {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
    const bufferedRequestIds = [...this.bufferedByTurn.values()]
      .flatMap((entries) => entries.map((entry) => entry.event.requestId));
    this.bufferedByTurn.clear();
    this.turnOwners.clear();
    this.retiredTurns.clear();
    this.bufferedTotal = 0;
    for (const requestId of bufferedRequestIds) {
      this.broker.cancelRequest(requestId);
    }
  }

  private deliver(runtime: CodexRuntime, event: BrokerRequestEvent): void {
    this.requestOwners.set(event.requestId, pendingRequestOwner(runtime, event));
    runtime.deliver(event);
  }

  private buffer(entry: BufferedBrokerRequest): void {
    const key = turnKey(entry.event.threadId!, entry.event.turnId!);
    const queue = this.bufferedByTurn.get(key) ?? [];
    while (queue.length >= CODEX_ROUTER_DEFAULTS.maxBufferedPerItem) {
      const evicted = queue.shift();
      if (evicted) {
        this.bufferedTotal--;
        this.broker.cancelRequest(evicted.event.requestId);
      }
    }
    while (this.bufferedTotal >= CODEX_ROUTER_DEFAULTS.maxBufferedTotal) {
      this.evictOldest();
    }
    queue.push(entry);
    this.bufferedTotal++;
    this.bufferedByTurn.set(key, queue);
    this.scheduleExpiry();
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldest: BufferedBrokerRequest | undefined;
    for (const [key, entries] of this.bufferedByTurn) {
      if (entries[0] && (!oldest || entries[0].sequence < oldest.sequence)) {
        oldestKey = key;
        oldest = entries[0];
      }
    }
    if (!oldestKey || !oldest) return;
    const queue = this.bufferedByTurn.get(oldestKey)!;
    queue.shift();
    this.bufferedTotal--;
    this.broker.cancelRequest(oldest.event.requestId);
    if (queue.length === 0) this.bufferedByTurn.delete(oldestKey);
  }

  private removeCandidate(runtimeId: string): void {
    for (const [key, entries] of this.bufferedByTurn) {
      const keep: BufferedBrokerRequest[] = [];
      const cancelRequestIds: string[] = [];
      for (const entry of entries) {
        entry.candidateRuntimeIds.delete(runtimeId);
        if (entry.candidateRuntimeIds.size > 0) {
          keep.push(entry);
        } else {
          this.bufferedTotal--;
          cancelRequestIds.push(entry.event.requestId);
        }
      }
      if (keep.length === 0) this.bufferedByTurn.delete(key);
      else this.bufferedByTurn.set(key, keep);
      for (const requestId of cancelRequestIds) {
        this.broker.cancelRequest(requestId);
      }
    }
    this.scheduleExpiry();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entries] of this.bufferedByTurn) {
      const keep: BufferedBrokerRequest[] = [];
      const cancelRequestIds: string[] = [];
      for (const entry of entries) {
        if (entry.expiresAt > now) {
          keep.push(entry);
        } else {
          this.bufferedTotal--;
          cancelRequestIds.push(entry.event.requestId);
        }
      }
      if (keep.length === 0) this.bufferedByTurn.delete(key);
      else this.bufferedByTurn.set(key, keep);
      for (const requestId of cancelRequestIds) {
        this.broker.cancelRequest(requestId);
      }
    }
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer as ReturnType<typeof setTimeout>);
      this.expiryTimer = undefined;
    }
    let nearest = Number.POSITIVE_INFINITY;
    for (const entries of this.bufferedByTurn.values()) {
      for (const entry of entries) nearest = Math.min(nearest, entry.expiresAt);
    }
    if (!Number.isFinite(nearest)) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.pruneExpired();
    }, Math.max(0, nearest - Date.now()));
  }

  private retire(key: string): void {
    const existing = this.retiredTurns.get(key);
    if (existing !== undefined) {
      clearTimeout(existing as ReturnType<typeof setTimeout>);
    }
    const buffered = this.bufferedByTurn.get(key) ?? [];
    this.bufferedByTurn.delete(key);
    for (const entry of buffered) {
      this.bufferedTotal--;
      this.broker.cancelRequest(entry.event.requestId);
    }
    const timer = setTimeout(() => {
      this.retiredTurns.delete(key);
    }, CODEX_ROUTER_DEFAULTS.retiredTurnTtlMs);
    this.retiredTurns.set(key, timer);
    this.scheduleExpiry();
  }
}

export class CodexProvider implements ChatProvider {
  readonly id = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;

  private readonly runtimes = new Map<string, CodexRuntime>();
  private readonly processFactory: () => Promise<CodexAppServerProcess>;
  private readonly clientFactory: CodexClientFactory;
  private active: ActiveConnection | undefined;
  private connecting: Promise<ActiveConnection> | undefined;
  private generation = 0;
  private nextRuntimeId = 1;
  private cleaned = false;

  constructor(private readonly options: CodexProviderOptions) {
    this.processFactory = options.processFactory ?? (() =>
      spawnCodexAppServer({ command: options.command }));
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  createRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
    if (this.cleaned) throw new Error("Codex provider has been cleaned up");
    const runtime = new CodexRuntime(
      `codex-runtime-${this.nextRuntimeId++}`,
      this,
      options,
    );
    this.runtimes.set(runtime.runtimeId, runtime);
    return runtime;
  }

  async listSessions(cwd: string): Promise<ProviderSessionSummary[]> {
    const connection = await this.ensureConnection();
    const summaries: ProviderSessionSummary[] = [];
    let cursor: string | null = null;
    do {
      const response = await connection.client.threadList({
        cwd,
        sourceKinds: ["cli", "vscode", "appServer"],
        sortKey: "updated_at",
        sortDirection: "desc",
        ...(cursor ? { cursor } : {}),
      });
      summaries.push(...response.data.map(mapThreadSummary));
      cursor = response.nextCursor;
    } while (cursor);
    return summaries;
  }

  async loadSession(_cwd: string, sessionId: string): Promise<ProviderHistoryMessage[]> {
    const connection = await this.ensureConnection();
    const response = await connection.client.threadRead({
      threadId: sessionId,
      includeTurns: true,
    });
    return mapThreadHistory(response.thread);
  }

  async renameSession(_cwd: string, sessionId: string, title: string): Promise<void> {
    const connection = await this.ensureConnection();
    await connection.client.threadSetName({ threadId: sessionId, name: title });
  }

  async recoverSession(
    _cwd: string,
    _sessionId: string,
  ): Promise<ProviderRecoveryResult> {
    return {
      success: false,
      linesRemoved: 0,
      capturedUserText: null,
      reason: "Codex app-server sessions do not support local JSONL repair.",
    };
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const connection = await this.ensureConnection();
    const models: ModelListResponse["data"] = [];
    let cursor: string | null = null;
    do {
      const response = await connection.client.modelList({
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      models.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return models.map((model) => ({
      id: model.model,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      defaultEffort: model.defaultReasoningEffort,
      effortOptions: model.supportedReasoningEfforts.map((option) => ({
        id: option.reasoningEffort,
        description: option.description,
      })),
      inputModalities: model.inputModalities,
      supportsPersonality: model.supportsPersonality,
    }));
  }

  async listSkills(cwd: string): Promise<ProviderSkillInfo[]> {
    const connection = await this.ensureConnection();
    const response = await connection.client.skillsList({ cwds: [cwd] });
    return response.data.flatMap((entry) =>
      entry.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        scope: skill.scope,
        enabled: skill.enabled,
        cwd: entry.cwd,
      })),
    );
  }

  async getRateLimits(): Promise<ProviderRateLimits> {
    const connection = await this.ensureConnection();
    const response = await connection.client.accountRateLimitsRead();
    return {
      default: mapRateLimit(response.rateLimits),
      byId: Object.fromEntries(
        Object.entries(response.rateLimitsByLimitId ?? {}).flatMap(([id, value]) =>
          value ? [[id, mapRateLimit(value)]] : []),
      ),
    };
  }

  async getAuthState(refreshToken = false): Promise<ProviderAuthState> {
    const connection = await this.ensureConnection();
    const response = await connection.client.accountRead({ refreshToken });
    const account = response.account;
    return {
      authenticated: account !== null,
      requiresAuth: response.requiresOpenaiAuth,
      accountType: account?.type ?? null,
      ...(account?.type === "chatgpt"
        ? { email: account.email, plan: account.planType }
        : {}),
    };
  }

  async startLogin(method: ProviderLoginMethod): Promise<ProviderLoginStartResult> {
    const connection = await this.ensureConnection();
    const response = method === "browser"
      ? await connection.client.startChatGptBrowserLogin({
        useHostedLoginSuccessPage: true,
      })
      : await connection.client.startChatGptDeviceLogin();
    return mapLogin(response);
  }

  async cancelLogin(loginId: string): Promise<void> {
    const connection = await this.ensureConnection();
    await connection.client.cancelAccountLogin({ loginId });
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const runtime of [...this.runtimes.values()]) runtime.cleanup();
    const connection = this.active;
    this.active = undefined;
    if (connection) this.stopConnection(connection);
    void this.connecting?.then(
      (pending) => this.stopConnection(pending),
      () => undefined,
    );
    this.connecting = undefined;
  }

  async ensureRuntimeThread(runtime: CodexRuntime): Promise<ActiveConnection> {
    const connection = await this.ensureConnection();
    await runtime.attach(connection);
    return connection;
  }

  getActiveConnection(): ActiveConnection | undefined {
    return this.active;
  }

  isActive(connection: ActiveConnection): boolean {
    return this.active === connection && !connection.failed && !connection.stopping;
  }

  unregisterRuntime(runtime: CodexRuntime): void {
    if (this.runtimes.get(runtime.runtimeId) !== runtime) return;
    const connection = this.active;
    connection?.requestRouter.cleanupRuntime(runtime);
    if (connection) {
      for (const [requestId, owner] of connection.requestOwners) {
        if (owner.runtimeId === runtime.runtimeId) {
          connection.requestOwners.delete(requestId);
        }
      }
    }
    this.runtimes.delete(runtime.runtimeId);
    connection?.router.unregisterRuntime(runtime.runtimeId);
  }

  bindRuntimeTurn(
    runtime: CodexRuntime,
    connection: ActiveConnection,
    turnId: string,
  ): boolean {
    if (!this.isActive(connection)) return false;
    const notificationBound = connection.router.bindTurn(runtime.runtimeId, turnId);
    const requestBound = connection.requestRouter.bind(runtime, turnId);
    return notificationBound && requestBound;
  }

  failPendingRuntimeTurn(
    runtime: CodexRuntime,
    connection: ActiveConnection,
  ): void {
    if (this.active === connection) connection.requestRouter.failPending(runtime);
  }

  retireRuntimeTurn(runtime: CodexRuntime, turnId: string): void {
    this.active?.requestRouter.retireRuntimeTurn(runtime, turnId);
  }

  respondApproval(
    runtime: CodexRuntime,
    requestId: string,
    behavior: ProviderApprovalBehavior,
  ): boolean {
    const connection = this.active;
    const owner = connection?.requestOwners.get(requestId);
    if (!connection || owner?.runtimeId !== runtime.runtimeId) {
      return false;
    }
    if (owner.approvalKind === "permissions") {
      if (behavior === "deny") return false;
      const permissions = Object.fromEntries(
        Object.entries(owner.permissions ?? {}).filter(([, value]) => value != null),
      );
      const accepted = connection.broker.respondPermissions(requestId, {
        permissions,
        scope: behavior === "allow_always" ? "session" : "turn",
      });
      if (accepted) connection.requestOwners.delete(requestId);
      return accepted;
    }
    const response: ProviderApprovalResponse = {
      decision: behavior === "allow_always"
        ? "allow_session"
        : behavior === "allow"
          ? "allow"
          : "deny",
    };
    const accepted = connection.broker.respondApproval(requestId, response);
    if (accepted) connection.requestOwners.delete(requestId);
    return accepted;
  }

  respondQuestion(
    runtime: CodexRuntime,
    requestId: string,
    answers: Record<string, string>,
  ): boolean {
    const connection = this.active;
    if (!connection || connection.requestOwners.get(requestId)?.runtimeId !== runtime.runtimeId) {
      return false;
    }
    const accepted = connection.broker.respondQuestion(requestId, answers);
    if (accepted) connection.requestOwners.delete(requestId);
    return accepted;
  }

  private ensureConnection(): Promise<ActiveConnection> {
    if (this.cleaned) {
      return Promise.reject(new Error("Codex provider has been cleaned up"));
    }
    if (this.active) return Promise.resolve(this.active);
    if (this.connecting) return this.connecting;
    const pending = this.createConnection();
    this.connecting = pending;
    void pending.finally(() => {
      if (this.connecting === pending) this.connecting = undefined;
    }).catch(() => undefined);
    return pending;
  }

  private async createConnection(): Promise<ActiveConnection> {
    const generation = ++this.generation;
    const router = new CodexNotificationRouter();
    const requestOwners = new Map<string, PendingRequestOwner>();
    let connection: ActiveConnection | undefined;
    let requestRouter!: CodexBrokerRequestRouter;
    const broker = new CodexServerRequestBroker((event) => {
      this.routeBrokerEvent(connection, requestRouter, requestOwners, event);
    });
    requestRouter = new CodexBrokerRequestRouter(
      generation,
      broker,
      requestOwners,
      () => this.runtimes.values(),
      (runtimeId) => this.runtimes.get(runtimeId),
    );
    const handlers: CodexConnectionHandlers = {
      onNotification: (notification) => {
        if (notification.method === "serverRequest/resolved") {
          broker.handleNotification(notification as never);
          return;
        }
        router.route(notification);
      },
      onServerRequest: (request) => broker.handle(request as never),
    };
    const process = await this.processFactory();
    try {
      const initialized = await this.clientFactory(process, handlers, {
        version: this.options.appVersion,
      });
      connection = {
        generation,
        process,
        client: initialized.client,
        disposeClient: initialized.dispose,
        router,
        broker,
        requestRouter,
        requestOwners,
        stopping: false,
        failed: false,
      };
      if (this.cleaned) {
        this.stopConnection(connection);
        throw new Error("Codex provider was cleaned up while connecting");
      }
      this.active = connection;
      this.watchProcess(connection);
      return connection;
    } catch (error) {
      router.dispose();
      requestRouter.dispose();
      broker.dispose();
      if (!connection?.stopping) {
        void process.stop().catch(() => undefined);
      }
      throw error;
    }
  }

  private routeBrokerEvent(
    connection: ActiveConnection | undefined,
    requestRouter: CodexBrokerRequestRouter,
    requestOwners: Map<string, PendingRequestOwner>,
    event: ProviderEvent,
  ): void {
    if (event.type === "approval_requested" || event.type === "question_requested") {
      requestRouter.route(event);
      return;
    }
    if (event.type === "request_resolved") {
      requestRouter.forgetRequest(event.requestId);
      const runtimeId = requestOwners.get(event.requestId)?.runtimeId;
      requestOwners.delete(event.requestId);
      const runtime = runtimeId ? this.runtimes.get(runtimeId) : undefined;
      runtime?.deliver(event);
      return;
    }
    if (connection && this.active !== connection) return;
  }

  private watchProcess(connection: ActiveConnection): void {
    void connection.process.failure.then((exit) => {
      this.handleConnectionFailure(connection, exit);
    });
    void connection.process.exit.then(
      (exit) => this.handleConnectionFailure(connection, exit),
      (error: unknown) => this.handleConnectionFailure(connection, error),
    );
  }

  private handleConnectionFailure(
    connection: ActiveConnection,
    cause: AppServerExit | unknown,
  ): void {
    if (
      connection.failed ||
      connection.stopping ||
      this.active !== connection
    ) return;
    connection.failed = true;
    this.active = undefined;
    connection.requestRouter.dispose();
    connection.broker.dispose();
    connection.router.dispose();
    connection.disposeClient();
    const error = connectionError(cause);
    for (const runtime of this.runtimes.values()) {
      runtime.connectionLost(connection, error);
    }
  }

  private stopConnection(connection: ActiveConnection): void {
    if (connection.stopping) return;
    connection.stopping = true;
    connection.requestRouter.dispose();
    connection.broker.dispose();
    connection.router.dispose();
    connection.disposeClient();
    void connection.process.stop().catch(() => undefined);
  }
}

export function createCodexProvider(
  options: CodexProviderOptions,
): ChatProvider {
  return new CodexProvider(options);
}

export class CodexRuntime implements ProviderRuntime {
  readonly providerId = "codex" as const;
  ready = false;
  threadId: string | undefined;
  currentTurnId: string | undefined;

  private started = false;
  private cleaned = false;
  private attachedGeneration: number | undefined;
  private attachPromise: Promise<void> | undefined;
  private turnInFlight = false;
  private failureGeneration: number | undefined;
  private reportedErrors = new WeakSet<Error>();
  private sendSequence = 0;
  private activeSend: { id: number; terminal: boolean } | undefined;
  private awaitingTurnGeneration: number | undefined;

  constructor(
    readonly runtimeId: string,
    private readonly provider: CodexProvider,
    private readonly options: ProviderRuntimeOptions,
  ) {
    const providerState = isProviderState(options.providerState)
      ? options.providerState
      : undefined;
    this.threadId = options.providerSessionId ?? providerState?.threadId;
    this.currentTurnId = providerState?.currentTurnId ?? undefined;
  }

  start(): void {
    if (this.cleaned || this.started) return;
    this.started = true;
    void this.provider.ensureRuntimeThread(this).catch((error: unknown) => {
      this.reportError(error);
    });
  }

  isRunning(): boolean {
    return this.started && !this.cleaned;
  }

  isAwaitingTurn(generation: number): boolean {
    return !this.cleaned && this.awaitingTurnGeneration === generation;
  }

  send(content: string | unknown[]): void {
    if (this.cleaned) return;
    if (!this.started) this.start();
    const sendId = ++this.sendSequence;
    this.activeSend = { id: sendId, terminal: false };
    void this.sendAsync(content).catch((error: unknown) => {
      this.turnInFlight = false;
      if (this.isSendPending(sendId)) this.reportError(error);
      this.finalizeSend(sendId, error);
    });
  }

  interrupt(): void {
    const connection = this.provider.getActiveConnection();
    if (!connection || !this.threadId || !this.currentTurnId) return;
    void connection.client.turnInterrupt({
      threadId: this.threadId,
      turnId: this.currentTurnId,
    }).catch((error: unknown) => this.reportError(error));
  }

  respondApproval(
    requestId: string,
    behavior: ProviderApprovalBehavior,
    _toolName?: string,
    _updatedInput?: Record<string, unknown>,
  ): void {
    this.provider.respondApproval(this, requestId, behavior);
  }

  respondQuestion(
    requestId: string,
    _questions: ProviderQuestion[],
    answers: Record<string, string>,
  ): void {
    this.provider.respondQuestion(this, requestId, answers);
  }

  compact(): void {
    if (this.cleaned) return;
    void (async () => {
      const connection = await this.provider.ensureRuntimeThread(this);
      if (!this.threadId) throw new Error("Codex thread is not ready");
      await connection.client.threadCompact({ threadId: this.threadId });
    })().catch((error: unknown) => this.reportError(error));
  }

  cleanup(): void {
    if (this.cleaned) return;
    const connection = this.provider.getActiveConnection();
    if (
      this.turnInFlight &&
      connection &&
      this.threadId &&
      this.currentTurnId
    ) {
      void connection.client.turnInterrupt({
        threadId: this.threadId,
        turnId: this.currentTurnId,
      }).catch(() => undefined);
    }
    this.cleaned = true;
    this.started = false;
    this.ready = false;
    this.provider.unregisterRuntime(this);
  }

  async attach(connection: ActiveConnection): Promise<void> {
    if (this.cleaned) throw new Error("Codex runtime has been cleaned up");
    if (this.attachedGeneration === connection.generation && this.ready) return;
    if (this.attachPromise) return this.attachPromise;
    const pending = this.attachToConnection(connection);
    this.attachPromise = pending;
    try {
      await pending;
    } finally {
      if (this.attachPromise === pending) this.attachPromise = undefined;
    }
  }

  deliver(event: ProviderEvent): void {
    if (this.cleaned) return;
    if (event.type === "turn_completed") {
      if (!this.acceptTerminalEvent()) return;
      this.turnInFlight = false;
      if (this.currentTurnId) {
        this.provider.retireRuntimeTurn(this, this.currentTurnId);
      }
    }
    this.options.onEvent(event);
  }

  connectionLost(connection: ActiveConnection, error: Error): void {
    if (this.attachedGeneration !== connection.generation && !this.turnInFlight) {
      return;
    }
    this.ready = false;
    this.attachedGeneration = undefined;
    this.attachPromise = undefined;
    if (this.turnInFlight && this.failureGeneration !== connection.generation) {
      this.failureGeneration = connection.generation;
      this.turnInFlight = false;
      const message = `${error.message}. Send again to reconnect and resume this Codex thread.`;
      this.reportError(new Error(message), {
        details: "Send again to reconnect and resume this Codex thread.",
      });
      this.finalizeActiveSend(message);
    }
  }

  private acceptTerminalEvent(): boolean {
    if (!this.activeSend) return true;
    if (this.activeSend.terminal) return false;
    this.activeSend.terminal = true;
    return true;
  }

  private finalizeSend(sendId: number, value: unknown): void {
    if (!this.activeSend || this.activeSend.id !== sendId) return;
    const error = value instanceof Error ? value : new Error(String(value));
    this.finalizeActiveSend(error.message);
  }

  private isSendPending(sendId: number): boolean {
    return this.activeSend?.id === sendId && !this.activeSend.terminal;
  }

  private finalizeActiveSend(message: string): void {
    if (this.cleaned) return;
    if (!this.acceptTerminalEvent()) return;
    this.options.onEvent({
      type: "turn_completed",
      status: "failed",
      error: message,
    });
  }

  private reportError(
    value: unknown,
    extra: { details?: string } = {},
  ): void {
    const error = value instanceof Error ? value : new Error(String(value));
    if (this.reportedErrors.has(error)) return;
    this.reportedErrors.add(error);
    this.deliver({
      type: "error",
      message: error.message,
      willRetry: false,
      ...(extra.details ? { details: extra.details } : {}),
    });
  }

  private async attachToConnection(connection: ActiveConnection): Promise<void> {
    if (this.threadId) {
      this.register(connection);
      await connection.client.threadResume({
        threadId: this.threadId,
        ...threadConfiguration(this.options),
      });
    } else {
      const response = await connection.client.threadStart(
        threadConfiguration(this.options),
      );
      this.threadId = response.thread.id;
      this.register(connection);
    }
    if (!this.provider.isActive(connection) || this.cleaned) {
      throw new Error("Codex app-server connection was lost while preparing the thread");
    }
    this.attachedGeneration = connection.generation;
    this.ready = true;
    this.emitSessionMetadata();
  }

  private register(connection: ActiveConnection): void {
    if (!this.threadId) return;
    connection.router.registerRuntime({
      runtimeId: this.runtimeId,
      threadId: this.threadId,
      onEvent: (event) => this.deliver(event),
    });
  }

  private async sendAsync(content: string | unknown[]): Promise<void> {
    const input = convertProviderInput(content);
    const connection = await this.provider.ensureRuntimeThread(this);
    if (!this.threadId) throw new Error("Codex thread is not ready");
    this.turnInFlight = true;
    this.awaitingTurnGeneration = connection.generation;
    let response: TurnStartResponse;
    try {
      response = await connection.client.turnStart({
        threadId: this.threadId,
        input,
      });
    } catch (error) {
      this.awaitingTurnGeneration = undefined;
      this.provider.failPendingRuntimeTurn(this, connection);
      throw error;
    }
    this.awaitingTurnGeneration = undefined;
    this.currentTurnId = response.turn.id;
    if (this.cleaned) {
      await connection.client.turnInterrupt({
        threadId: this.threadId,
        turnId: response.turn.id,
      }).catch(() => undefined);
      return;
    }
    if (!this.provider.isActive(connection)) {
      throw new Error("Codex app-server connection was lost while starting the turn");
    }
    if (!this.provider.bindRuntimeTurn(this, connection, response.turn.id)) {
      throw new Error(`Codex turn ${response.turn.id} could not be bound to its runtime`);
    }
    this.emitSessionMetadata();
  }

  private emitSessionMetadata(): void {
    if (!this.threadId) return;
    this.deliver({
      type: "session_metadata",
      sessionId: this.threadId,
      providerState: {
        threadId: this.threadId,
        currentTurnId: this.currentTurnId ?? null,
      },
    });
  }

}

function pendingRequestOwner(
  runtime: CodexRuntime,
  event: BrokerRequestEvent,
): PendingRequestOwner {
  if (event.type !== "approval_requested") {
    return { runtimeId: runtime.runtimeId };
  }
  const permissions =
    event.approvalKind === "permissions" &&
    typeof event.input === "object" &&
    event.input !== null &&
    "permissions" in event.input &&
    typeof event.input.permissions === "object" &&
    event.input.permissions !== null
      ? event.input.permissions as Record<string, unknown>
      : undefined;
  return {
    runtimeId: runtime.runtimeId,
    approvalKind: event.approvalKind,
    ...(permissions ? { permissions } : {}),
  };
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function splitTurnKey(key: string): [string, string] {
  const separator = key.indexOf("\u0000");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function threadConfiguration(options: ProviderRuntimeOptions): Omit<ThreadStartParams, "threadId"> {
  return {
    cwd: options.cwd,
    model: options.model,
    approvalPolicy: mapApprovalPolicy(options.permissionMode),
    sandbox: mapSandbox(options.permissionMode),
  };
}

function mapApprovalPolicy(permissionMode: string): "untrusted" | "on-request" | "never" {
  if (permissionMode === "bypassPermissions") return "never";
  if (permissionMode === "plan") return "untrusted";
  return "on-request";
}

function mapSandbox(permissionMode: string): "read-only" | "workspace-write" | "danger-full-access" {
  if (permissionMode === "bypassPermissions") return "danger-full-access";
  if (permissionMode === "plan") return "read-only";
  return "workspace-write";
}

async function defaultClientFactory(
  process: CodexAppServerProcess,
  handlers: CodexConnectionHandlers,
  metadata: { version: string },
): Promise<CodexClientConnection> {
  const transport = createProcessTransport(process, handlers);
  const client = await CodexAppServerClient.initialize(transport, metadata);
  return {
    client,
    dispose: () => transport.dispose(),
  };
}

function connectionError(cause: AppServerExit | unknown): Error {
  if (cause instanceof Error) {
    return new Error(`Codex app-server connection failed: ${cause.message}`);
  }
  if (isExit(cause)) {
    const status = cause.error?.message ??
      (cause.signal ? `signal ${cause.signal}` : `code ${String(cause.code)}`);
    const stderr = cause.stderr.trim();
    return new Error(
      `Codex app-server connection failed (${status})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return new Error(`Codex app-server connection failed: ${String(cause)}`);
}

function isExit(value: unknown): value is AppServerExit {
  return typeof value === "object" && value !== null && "stderr" in value;
}

function isProviderState(
  value: unknown,
): value is { threadId: string; currentTurnId?: string | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    (!("currentTurnId" in value) ||
      value.currentTurnId === null ||
      typeof value.currentTurnId === "string")
  );
}

function mapRateLimit(snapshot: RateLimitSnapshot): ProviderRateLimitInfo {
  return {
    id: snapshot.limitId,
    name: snapshot.limitName,
    primary: snapshot.primary ? {
      usedPercent: snapshot.primary.usedPercent,
      resetsAt: snapshot.primary.resetsAt == null
        ? null
        : new Date(snapshot.primary.resetsAt * 1_000),
      windowMinutes: snapshot.primary.windowDurationMins,
    } : null,
    secondary: snapshot.secondary ? {
      usedPercent: snapshot.secondary.usedPercent,
      resetsAt: snapshot.secondary.resetsAt == null
        ? null
        : new Date(snapshot.secondary.resetsAt * 1_000),
      windowMinutes: snapshot.secondary.windowDurationMins,
    } : null,
  };
}

function mapLogin(response: LoginAccountResponse): ProviderLoginStartResult {
  switch (response.type) {
    case "chatgpt":
      return { type: "browser", loginId: response.loginId, url: response.authUrl };
    case "chatgptDeviceCode":
      return {
        type: "device",
        loginId: response.loginId,
        url: response.verificationUrl,
        userCode: response.userCode,
      };
    case "apiKey":
    case "chatgptAuthTokens":
      return { type: "complete" };
  }
}
