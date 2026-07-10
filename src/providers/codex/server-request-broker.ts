import type {
  ProviderApprovalDecision,
  ProviderEvent,
  ProviderQuestion,
} from "../types";
import type { RequestId } from "./generated/RequestId";
import type { ServerRequest } from "./generated/ServerRequest";
import type { ServerNotification } from "./generated/ServerNotification";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse";
import type { ExecPolicyAmendment } from "./generated/v2/ExecPolicyAmendment";
import type { GrantedPermissionProfile } from "./generated/v2/GrantedPermissionProfile";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse";
import type { NetworkPolicyAmendment } from "./generated/v2/NetworkPolicyAmendment";
import type { PermissionGrantScope } from "./generated/v2/PermissionGrantScope";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse";
import type { ServerRequestResolvedNotification } from "./generated/v2/ServerRequestResolvedNotification";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse";

type PendingKind = "command" | "file" | "permissions" | "question";

interface PendingRequest {
  kind: PendingKind;
  threadId: string;
  uiRequestId: string;
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export type ProviderApprovalResponse =
  | { decision: "allow" | "allow_session" | "deny" | "cancel" }
  | { decision: "allow_execpolicy_amendment"; execpolicyAmendment: ExecPolicyAmendment }
  | { decision: "apply_network_policy_amendment"; networkPolicyAmendment: NetworkPolicyAmendment };

export interface ProviderPermissionsResponse {
  permissions: GrantedPermissionProfile;
  scope: PermissionGrantScope;
  strictAutoReview?: boolean;
}

export class JsonRpcMethodNotFoundError extends Error {
  readonly code = -32601;

  constructor(public readonly method: string) {
    super(`No handler for server request "${method}"`);
    this.name = "JsonRpcMethodNotFoundError";
  }
}

export class CodexServerRequestBroker {
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly requestIdsByUiKey = new Map<string, RequestId>();

  constructor(private readonly onEvent: (event: ProviderEvent) => void) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  handle(request: ServerRequest): Promise<unknown> {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return this.handleCommand(request);
      case "item/fileChange/requestApproval":
        return this.handleFileChange(request);
      case "item/permissions/requestApproval":
        return this.handlePermissions(request);
      case "item/tool/requestUserInput":
        return this.handleQuestion(request);
      default:
        return Promise.reject(new JsonRpcMethodNotFoundError((request as { method: string }).method));
    }
  }

  respondApproval(uiRequestId: string, response: ProviderApprovalResponse): boolean {
    const requestId = this.requestIdsByUiKey.get(uiRequestId);
    const active = requestId === undefined ? undefined : this.pending.get(requestId);
    if (!active || (active.kind !== "command" && active.kind !== "file")) return false;
    let wireResponse: CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse;
    if (active.kind === "command") {
      wireResponse = mapCommandResponse(response);
    } else {
      if (!isFileApprovalResponse(response)) return false;
      wireResponse = mapFileResponse(response);
    }
    const pending = this.take(uiRequestId, [active.kind]);
    if (!pending) return false;
    pending.resolve(wireResponse);
    return true;
  }

  respondPermissions(uiRequestId: string, response: ProviderPermissionsResponse): boolean {
    const pending = this.take(uiRequestId, ["permissions"]);
    if (!pending) return false;
    const wireResponse: PermissionsRequestApprovalResponse = {
      permissions: response.permissions,
      scope: response.scope,
      ...(response.strictAutoReview === undefined
        ? {}
        : { strictAutoReview: response.strictAutoReview }),
    };
    pending.resolve(wireResponse);
    return true;
  }

  respondQuestion(
    uiRequestId: string,
    answers: Record<string, string | string[]>,
  ): boolean {
    const pending = this.take(uiRequestId, ["question"]);
    if (!pending) return false;
    const response: ToolRequestUserInputResponse = {
      answers: Object.fromEntries(
        Object.entries(answers).map(([questionId, answer]) => [
          questionId,
          { answers: Array.isArray(answer) ? answer : [answer] },
        ]),
      ),
    };
    pending.resolve(response);
    return true;
  }

  handleNotification(
    notification: Extract<ServerNotification, { method: "serverRequest/resolved" }>,
  ): boolean {
    return this.resolve(notification.params);
  }

  resolve(notification: ServerRequestResolvedNotification): boolean {
    const pending = this.pending.get(notification.requestId);
    if (!pending || pending.threadId !== notification.threadId) return false;
    this.finish(notification.requestId, pending, null, "server");
    return true;
  }

  cancelRequest(uiRequestId: string): boolean {
    const requestId = this.requestIdsByUiKey.get(uiRequestId);
    const pending = requestId === undefined ? undefined : this.pending.get(requestId);
    if (requestId === undefined || !pending) return false;
    this.finish(
      requestId,
      pending,
      safeCancellationResponse(pending.kind),
      "server",
    );
    return true;
  }

  cancelThread(threadId: string): number {
    let cancelled = 0;
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.threadId !== threadId) continue;
      this.finish(
        requestId,
        pending,
        safeCancellationResponse(pending.kind),
        "server",
      );
      cancelled++;
    }
    return cancelled;
  }

  dispose(): void {
    for (const [requestId, pending] of [...this.pending]) {
      this.finish(requestId, pending, null, "server");
    }
  }

  private handleCommand(
    request: Extract<ServerRequest, { method: "item/commandExecution/requestApproval" }>,
  ): Promise<unknown> {
    const { params } = request;
    const availableDecisions: ProviderApprovalDecision[] = ["allow", "allow_session"];
    if (params.proposedExecpolicyAmendment) availableDecisions.push("allow_execpolicy_amendment");
    if (params.proposedNetworkPolicyAmendments?.length) {
      availableDecisions.push("apply_network_policy_amendment");
    }
    availableDecisions.push("deny", "cancel");
    return this.createPending(request.id, "command", params.threadId, {
      type: "approval_requested",
      requestId: toUiRequestId(request.id),
      toolName: "command",
      approvalKind: "command_execution",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      reason: params.reason ?? null,
      input: {
        command: params.command ?? null,
        cwd: params.cwd ?? null,
        environmentId: params.environmentId,
        approvalId: params.approvalId ?? null,
        commandActions: params.commandActions ?? null,
        networkApprovalContext: params.networkApprovalContext ?? null,
      },
      availableDecisions,
      proposedAmendments: {
        execpolicy: params.proposedExecpolicyAmendment ?? null,
        networkPolicy: params.proposedNetworkPolicyAmendments ?? null,
      },
    });
  }

  private handleFileChange(
    request: Extract<ServerRequest, { method: "item/fileChange/requestApproval" }>,
  ): Promise<unknown> {
    const { params } = request;
    return this.createPending(request.id, "file", params.threadId, {
      type: "approval_requested",
      requestId: toUiRequestId(request.id),
      toolName: "file change",
      approvalKind: "file_change",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      reason: params.reason ?? null,
      input: { grantRoot: params.grantRoot ?? null },
      availableDecisions: ["allow", "allow_session", "deny", "cancel"],
    });
  }

  private handlePermissions(
    request: Extract<ServerRequest, { method: "item/permissions/requestApproval" }>,
  ): Promise<unknown> {
    const { params } = request;
    return this.createPending(request.id, "permissions", params.threadId, {
      type: "approval_requested",
      requestId: toUiRequestId(request.id),
      toolName: "permissions",
      approvalKind: "permissions",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      reason: params.reason,
      input: {
        cwd: params.cwd,
        environmentId: params.environmentId,
        permissions: params.permissions,
      },
      availableDecisions: ["allow"],
      grantScopes: ["turn", "session"],
    });
  }

  private handleQuestion(
    request: Extract<ServerRequest, { method: "item/tool/requestUserInput" }>,
  ): Promise<unknown> {
    const { params } = request;
    const questions: ProviderQuestion[] = params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther,
      isSecret: question.isSecret,
      ...(question.options == null ? {} : { options: question.options }),
    }));
    return this.createPending(request.id, "question", params.threadId, {
      type: "question_requested",
      requestId: toUiRequestId(request.id),
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      autoResolutionMs: params.autoResolutionMs,
      questions,
    }, params.autoResolutionMs);
  }

  private createPending(
    requestId: RequestId,
    kind: PendingKind,
    threadId: string,
    event: ProviderEvent,
    autoResolutionMs: number | null = null,
  ): Promise<unknown> {
    const uiRequestId = toUiRequestId(requestId);
    if (this.pending.has(requestId)) {
      return Promise.reject(new Error(`Duplicate Codex server request id: ${uiRequestId}`));
    }
    let pending!: PendingRequest;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending = { kind, threadId, uiRequestId, resolve, reject };
    });
    if (autoResolutionMs != null) {
      pending.timer = setTimeout(() => {
        const active = this.pending.get(requestId);
        if (active === pending) this.finish(requestId, pending, null, "auto");
      }, autoResolutionMs);
    }
    this.pending.set(requestId, pending);
    this.requestIdsByUiKey.set(uiRequestId, requestId);
    try {
      this.onEvent(event);
    } catch (error) {
      this.rollback(requestId, pending);
      pending.reject(asError(error));
    }
    return promise;
  }

  private take(uiRequestId: string, kinds: PendingKind[]): PendingRequest | undefined {
    const requestId = this.requestIdsByUiKey.get(uiRequestId);
    if (requestId === undefined) return undefined;
    const pending = this.pending.get(requestId);
    if (!pending || !kinds.includes(pending.kind)) return undefined;
    this.pending.delete(requestId);
    this.requestIdsByUiKey.delete(uiRequestId);
    if (pending.timer) clearTimeout(pending.timer);
    return pending;
  }

  private finish(
    requestId: RequestId,
    pending: PendingRequest,
    response: unknown,
    reason: "server" | "auto",
  ): void {
    this.pending.delete(requestId);
    this.requestIdsByUiKey.delete(pending.uiRequestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(response);
    try {
      this.onEvent({ type: "request_resolved", requestId: pending.uiRequestId, reason });
    } catch {
      // Terminal UI delivery must not escape cleanup or alter promise resolution.
    }
  }

  private rollback(requestId: RequestId, pending: PendingRequest): void {
    if (this.pending.get(requestId) === pending) this.pending.delete(requestId);
    if (this.requestIdsByUiKey.get(pending.uiRequestId) === requestId) {
      this.requestIdsByUiKey.delete(pending.uiRequestId);
    }
    if (pending.timer) clearTimeout(pending.timer);
  }
}

function toUiRequestId(requestId: RequestId): string {
  return `${typeof requestId}:${String(requestId)}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function safeCancellationResponse(kind: PendingKind): unknown {
  switch (kind) {
    case "command":
    case "file":
      return { decision: "cancel" };
    case "permissions":
      return { permissions: {}, scope: "turn" };
    case "question":
      return { answers: {} };
  }
}

function mapCommandResponse(
  response: ProviderApprovalResponse,
): CommandExecutionRequestApprovalResponse {
  switch (response.decision) {
    case "allow":
      return { decision: "accept" };
    case "allow_session":
      return { decision: "acceptForSession" };
    case "allow_execpolicy_amendment":
      return {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: response.execpolicyAmendment,
          },
        },
      };
    case "apply_network_policy_amendment":
      return {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: response.networkPolicyAmendment,
          },
        },
      };
    case "deny":
      return { decision: "decline" };
    case "cancel":
      return { decision: "cancel" };
  }
}

function mapFileResponse(
  response: Extract<ProviderApprovalResponse, { decision: "allow" | "allow_session" | "deny" | "cancel" }>,
): FileChangeRequestApprovalResponse {
  switch (response.decision) {
    case "allow":
      return { decision: "accept" };
    case "allow_session":
      return { decision: "acceptForSession" };
    case "deny":
      return { decision: "decline" };
    case "cancel":
      return { decision: "cancel" };
  }
}

function isFileApprovalResponse(
  response: ProviderApprovalResponse,
): response is Extract<ProviderApprovalResponse, { decision: "allow" | "allow_session" | "deny" | "cancel" }> {
  return response.decision === "allow" ||
    response.decision === "allow_session" ||
    response.decision === "deny" ||
    response.decision === "cancel";
}
