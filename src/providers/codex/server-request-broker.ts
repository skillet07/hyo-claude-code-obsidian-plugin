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
  resolve: (response: unknown) => void;
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
  private readonly pending = new Map<string, PendingRequest>();

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

  respondApproval(requestId: string, response: ProviderApprovalResponse): boolean {
    const active = this.pending.get(requestId);
    if (!active || (active.kind !== "command" && active.kind !== "file")) return false;
    let wireResponse: CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse;
    if (active.kind === "command") {
      wireResponse = mapCommandResponse(response);
    } else {
      if (!isFileApprovalResponse(response)) return false;
      wireResponse = mapFileResponse(response);
    }
    const pending = this.take(requestId, [active.kind]);
    if (!pending) return false;
    pending.resolve(wireResponse);
    return true;
  }

  respondPermissions(requestId: string, response: ProviderPermissionsResponse): boolean {
    const pending = this.take(requestId, ["permissions"]);
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
    requestId: string,
    answers: Record<string, string | string[]>,
  ): boolean {
    const pending = this.take(requestId, ["question"]);
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
    const key = String(notification.requestId);
    const pending = this.pending.get(key);
    if (!pending || pending.threadId !== notification.threadId) return false;
    this.finish(key, pending, null, "server");
    return true;
  }

  dispose(): void {
    for (const [requestId, pending] of this.pending) {
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
    const promise = this.createPending(request.id, "command", params.threadId);
    this.onEvent({
      type: "approval_requested",
      requestId: String(request.id),
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
    return promise;
  }

  private handleFileChange(
    request: Extract<ServerRequest, { method: "item/fileChange/requestApproval" }>,
  ): Promise<unknown> {
    const { params } = request;
    const promise = this.createPending(request.id, "file", params.threadId);
    this.onEvent({
      type: "approval_requested",
      requestId: String(request.id),
      toolName: "file change",
      approvalKind: "file_change",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      reason: params.reason ?? null,
      input: { grantRoot: params.grantRoot ?? null },
      availableDecisions: ["allow", "allow_session", "deny", "cancel"],
    });
    return promise;
  }

  private handlePermissions(
    request: Extract<ServerRequest, { method: "item/permissions/requestApproval" }>,
  ): Promise<unknown> {
    const { params } = request;
    const promise = this.createPending(request.id, "permissions", params.threadId);
    this.onEvent({
      type: "approval_requested",
      requestId: String(request.id),
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
    return promise;
  }

  private handleQuestion(
    request: Extract<ServerRequest, { method: "item/tool/requestUserInput" }>,
  ): Promise<unknown> {
    const { params } = request;
    const promise = this.createPending(
      request.id,
      "question",
      params.threadId,
      params.autoResolutionMs,
    );
    const questions: ProviderQuestion[] = params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther,
      isSecret: question.isSecret,
      ...(question.options == null ? {} : { options: question.options }),
    }));
    this.onEvent({
      type: "question_requested",
      requestId: String(request.id),
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      autoResolutionMs: params.autoResolutionMs,
      questions,
    });
    return promise;
  }

  private createPending(
    requestId: RequestId,
    kind: PendingKind,
    threadId: string,
    autoResolutionMs: number | null = null,
  ): Promise<unknown> {
    const key = String(requestId);
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`Duplicate Codex server request id: ${key}`));
    }
    return new Promise((resolve) => {
      const pending: PendingRequest = { kind, threadId, resolve };
      if (autoResolutionMs != null) {
        pending.timer = setTimeout(() => {
          const active = this.pending.get(key);
          if (active === pending) this.finish(key, pending, null, "auto");
        }, autoResolutionMs);
      }
      this.pending.set(key, pending);
    });
  }

  private take(requestId: string, kinds: PendingKind[]): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending || !kinds.includes(pending.kind)) return undefined;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    return pending;
  }

  private finish(
    requestId: string,
    pending: PendingRequest,
    response: unknown,
    reason: "server" | "auto",
  ): void {
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(response);
    this.onEvent({ type: "request_resolved", requestId, reason });
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
