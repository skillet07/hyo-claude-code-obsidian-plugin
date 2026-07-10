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
import { CodexNotificationRouter } from "./notification-router";
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
  requestOwners: Map<string, PendingRequestOwner>;
  stopping: boolean;
  failed: boolean;
}

interface PendingRequestOwner {
  runtimeId: string;
  approvalKind?: "command_execution" | "file_change" | "permissions";
  permissions?: Record<string, unknown>;
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
    this.runtimes.delete(runtime.runtimeId);
    this.active?.router.unregisterRuntime(runtime.runtimeId);
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
    const broker = new CodexServerRequestBroker((event) => {
      this.routeBrokerEvent(connection, requestOwners, event);
    });
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
      broker.dispose();
      if (!connection?.stopping) {
        void process.stop().catch(() => undefined);
      }
      throw error;
    }
  }

  private routeBrokerEvent(
    connection: ActiveConnection | undefined,
    requestOwners: Map<string, PendingRequestOwner>,
    event: ProviderEvent,
  ): void {
    if (event.type === "approval_requested" || event.type === "question_requested") {
      const runtime = [...this.runtimes.values()].find(
        (candidate) => candidate.threadId === event.threadId,
      );
      if (!runtime) return;
      requestOwners.set(event.requestId, {
        runtimeId: runtime.runtimeId,
        ...(event.type === "approval_requested"
          ? {
            approvalKind: event.approvalKind,
            ...(event.approvalKind === "permissions" &&
              typeof event.input === "object" &&
              event.input !== null &&
              "permissions" in event.input &&
              typeof event.input.permissions === "object" &&
              event.input.permissions !== null
              ? { permissions: event.input.permissions as Record<string, unknown> }
              : {}),
          }
          : {}),
      });
      runtime.deliver(event);
      return;
    }
    if (event.type === "request_resolved") {
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
  private turnFailureReported = false;
  private failureGeneration: number | undefined;
  private reportedErrors = new WeakSet<Error>();

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
      this.reportError(error, false);
    });
  }

  isRunning(): boolean {
    return this.started && !this.cleaned;
  }

  send(content: string | unknown[]): void {
    if (this.cleaned) return;
    if (!this.started) this.start();
    this.turnFailureReported = false;
    void this.sendAsync(content).catch((error: unknown) => {
      this.turnInFlight = false;
      if (!this.turnFailureReported) this.reportError(error, true);
    });
  }

  interrupt(): void {
    const connection = this.provider.getActiveConnection();
    if (!connection || !this.threadId || !this.currentTurnId) return;
    void connection.client.turnInterrupt({
      threadId: this.threadId,
      turnId: this.currentTurnId,
    }).catch((error: unknown) => this.reportError(error, false));
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
    })().catch((error: unknown) => this.reportError(error, false));
  }

  cleanup(): void {
    if (this.cleaned) return;
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
    if (event.type === "turn_completed") this.turnInFlight = false;
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
      this.turnFailureReported = true;
      const message = `${error.message}. Send again to reconnect and resume this Codex thread.`;
      this.deliver({
        type: "error",
        message,
        willRetry: false,
        details: "Send again to reconnect and resume this Codex thread.",
      });
      this.deliver({
        type: "turn_completed",
        status: "failed",
        error: message,
      });
    }
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
    const response = await connection.client.turnStart({
      threadId: this.threadId,
      input,
    });
    if (!this.provider.isActive(connection)) {
      throw new Error("Codex app-server connection was lost while starting the turn");
    }
    this.currentTurnId = response.turn.id;
    connection.router.bindTurn(this.runtimeId, response.turn.id);
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

  private reportError(value: unknown, completeTurn: boolean): void {
    const error = value instanceof Error ? value : new Error(String(value));
    if (this.reportedErrors.has(error)) return;
    this.reportedErrors.add(error);
    this.deliver({ type: "error", message: error.message, willRetry: false });
    if (completeTurn) {
      this.deliver({ type: "turn_completed", status: "failed", error: error.message });
    }
  }
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
