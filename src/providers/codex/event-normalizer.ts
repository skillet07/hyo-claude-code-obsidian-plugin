import type { ProviderEvent, ProviderToolActivity } from "../types";
import type { ServerNotification } from "./generated/ServerNotification";
import type { ThreadItem } from "./generated/v2/ThreadItem";

type ForwardCollabItem = Omit<
  Extract<ThreadItem, { type: "collabAgentToolCall" }>,
  "type"
> & { type: "collabToolCall" };

type BoundaryNotification = ServerNotification | {
  method: string;
  params?: unknown;
};

type ItemLifecycleParams = {
  threadId: string;
  turnId: string;
  item: ThreadItem | ForwardCollabItem | UnknownItem;
};

type UnknownItem = { type: string; id?: string } & Record<string, unknown>;

export interface CodexEventNormalizerOptions {
  onUnknownNotification?: (diagnostic: { method: string }) => void;
}

export class CodexEventNormalizer {
  constructor(private readonly options: CodexEventNormalizerOptions = {}) {}

  normalize(notification: BoundaryNotification): ProviderEvent[] {
    const params = notification.params as Record<string, any> | undefined;
    switch (notification.method) {
      case "item/agentMessage/delta":
        return [{ type: "text_delta", delta: params?.delta ?? "", itemId: params?.itemId }];
      case "item/reasoning/summaryTextDelta":
        return [{
          type: "thinking_delta",
          delta: params?.delta ?? "",
          itemId: params?.itemId,
          channel: "summary",
          index: params?.summaryIndex,
        }];
      case "item/reasoning/textDelta":
        return [{
          type: "thinking_delta",
          delta: params?.delta ?? "",
          itemId: params?.itemId,
          channel: "content",
          index: params?.contentIndex,
        }];
      case "item/reasoning/summaryPartAdded":
        return [];
      case "item/plan/delta":
        return [{ type: "plan_delta", itemId: params?.itemId ?? "", delta: params?.delta ?? "" }];
      case "turn/plan/updated":
        return [{
          type: "plan_updated",
          explanation: params?.explanation ?? null,
          steps: (params?.plan ?? []).map((step: { step: string; status: string }) => ({
            step: step.step,
            status: normalizeStatus(step.status),
          })),
          final: false,
        }];
      case "item/commandExecution/outputDelta":
        return [toolUpdate(params?.itemId, "command_execution", "command", { outputDelta: params?.delta ?? "" })];
      case "item/fileChange/outputDelta":
        return [toolUpdate(params?.itemId, "file_change", "file change", { outputDelta: params?.delta ?? "" })];
      case "item/fileChange/patchUpdated":
        return [toolUpdate(params?.itemId, "file_change", "file change", { changes: params?.changes ?? [] })];
      case "item/mcpToolCall/progress":
        return [toolUpdate(params?.itemId, "mcp_tool_call", "MCP tool", { outputDelta: params?.message ?? "" })];
      case "item/started":
        return this.normalizeItemLifecycle("started", params as ItemLifecycleParams);
      case "item/completed":
        return this.normalizeItemLifecycle("completed", params as ItemLifecycleParams);
      case "thread/compacted":
        return [{ type: "compaction_boundary" }];
      case "thread/tokenUsage/updated": {
        const usage = params?.tokenUsage;
        return usage ? [{
          type: "token_usage",
          inputTokens: usage.total.inputTokens,
          outputTokens: usage.total.outputTokens,
          cachedInputTokens: usage.total.cachedInputTokens,
          reasoningOutputTokens: usage.total.reasoningOutputTokens,
          totalTokens: usage.total.totalTokens,
          ...(usage.modelContextWindow == null ? {} : { contextWindow: usage.modelContextWindow }),
        }] : [];
      }
      case "turn/completed": {
        const turn = params?.turn;
        if (!turn || turn.status === "inProgress") return [];
        return [{
          type: "turn_completed",
          status: turn.status,
          ...(turn.error?.message ? { error: turn.error.message } : {}),
        }];
      }
      case "warning":
      case "guardianWarning":
        return [{ type: "warning", message: String(params?.message ?? "Codex warning") }];
      case "deprecationNotice":
      case "configWarning": {
        const summary = String(params?.summary ?? "Codex warning");
        const details = typeof params?.details === "string" && params.details
          ? `: ${params.details}`
          : "";
        return [{ type: "warning", message: `${summary}${details}` }];
      }
      case "error":
        return [{
          type: "error",
          message: String(params?.error?.message ?? "Unknown Codex error"),
          willRetry: Boolean(params?.willRetry),
          details: params?.error?.additionalDetails ?? null,
        }];
      default:
        this.options.onUnknownNotification?.({ method: notification.method });
        return [];
    }
  }

  private normalizeItemLifecycle(
    phase: "started" | "completed",
    params: ItemLifecycleParams,
  ): ProviderEvent[] {
    // The generated union is widened only at this boundary so a future stable
    // item discriminator can still receive the provider-neutral fallback card.
    const item = params.item as any;
    switch (item.type) {
      case "userMessage":
      case "hookPrompt":
        return [];
      case "agentMessage":
        return phase === "completed" ? [{
          type: "agent_message_completed",
          itemId: item.id,
          text: item.text,
          replaceExisting: true,
        }] : [];
      case "reasoning":
        return phase === "completed" ? [{
          type: "reasoning_completed",
          itemId: item.id,
          summary: item.summary,
          content: item.content,
        }] : [];
      case "plan":
        return phase === "completed" ? [{
          type: "plan_updated",
          itemId: item.id,
          text: item.text,
          final: true,
        }] : [];
      case "commandExecution":
        return [{
          type: "tool_activity",
          phase,
          tool: compactTool({
            id: item.id,
            kind: "command_execution",
            name: "command",
            status: normalizeStatus(item.status),
            input: { command: item.command, cwd: item.cwd },
            ...(item.aggregatedOutput == null ? {} : { output: item.aggregatedOutput }),
            metadata: {
              exitCode: item.exitCode,
              durationMs: item.durationMs,
              processId: item.processId,
            },
          }),
        }];
      case "fileChange":
        return [{
          type: "tool_activity",
          phase,
          tool: {
            id: item.id,
            kind: "file_change",
            name: "file change",
            status: normalizeStatus(item.status),
            changes: item.changes,
          },
        }];
      case "mcpToolCall":
        return [{
          type: "tool_activity",
          phase,
          tool: compactTool({
            id: item.id,
            kind: "mcp_tool_call",
            name: `${item.server}.${item.tool}`,
            status: normalizeStatus(item.status),
            input: item.arguments,
            ...(item.result ? { output: item.result } : item.error ? { output: item.error.message } : {}),
            metadata: {
              server: item.server,
              pluginId: item.pluginId,
              ...(item.durationMs == null ? {} : { durationMs: item.durationMs }),
            },
          }),
        }];
      case "dynamicToolCall":
        return [{
          type: "tool_activity",
          phase,
          tool: compactTool({
            id: item.id,
            kind: "dynamic_tool_call",
            name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
            status: normalizeStatus(item.status),
            input: item.arguments,
            ...(item.contentItems == null ? {} : { output: item.contentItems }),
            metadata: {
              success: item.success,
              ...(item.durationMs == null ? {} : { durationMs: item.durationMs }),
            },
          }),
        }];
      case "webSearch":
        return [{
          type: "tool_activity",
          phase,
          tool: compactTool({
            id: item.id,
            kind: "web_search",
            name: "web search",
            input: { query: item.query },
            ...(item.action == null ? {} : { output: item.action }),
          }),
        }];
      case "imageView":
        return [{
          type: "tool_activity",
          phase,
          tool: { id: item.id, kind: "image_view", name: "image view", input: { path: item.path } },
        }];
      case "sleep":
        return [{
          type: "tool_activity",
          phase,
          tool: {
            id: item.id,
            kind: "sleep",
            name: "sleep",
            input: { durationMs: item.durationMs },
          },
        }];
      case "imageGeneration":
        return [{
          type: "tool_activity",
          phase,
          tool: compactTool({
            id: item.id,
            kind: "image_generation",
            name: "image generation",
            status: normalizeStatus(item.status),
            input: { revisedPrompt: item.revisedPrompt },
            output: item.result,
            metadata: item.savedPath === undefined ? {} : { savedPath: item.savedPath },
          }),
        }];
      case "collabAgentToolCall":
      case "collabToolCall":
        return isCollabItem(item)
          ? [normalizeCollab(phase, item)]
          : [unknownItemEvent(phase, item)];
      case "subAgentActivity":
        return [{
          type: "subagent_status",
          phase,
          id: item.id,
          activity: item.kind,
          agentThreadId: item.agentThreadId,
          agentPath: item.agentPath,
        }];
      case "enteredReviewMode":
      case "exitedReviewMode":
        return [{
          type: "review_mode_changed",
          itemId: item.id,
          active: item.type === "enteredReviewMode",
          review: item.review,
        }];
      case "contextCompaction":
        return phase === "completed" ? [{ type: "compaction_boundary" }] : [];
      default:
        return [unknownItemEvent(phase, item)];
    }
  }
}

function unknownItemEvent(
  phase: "started" | "completed",
  item: UnknownItem,
): Extract<ProviderEvent, { type: "tool_activity" }> {
  return {
    type: "tool_activity",
    phase,
    tool: {
      id: typeof item.id === "string" ? item.id : `${item.type}-unknown`,
      kind: "unknown",
      name: item.type,
      metadata: { itemType: item.type },
    },
  };
}

function toolUpdate(
  id: string,
  kind: ProviderToolActivity["kind"],
  name: string,
  patch: Partial<ProviderToolActivity>,
): Extract<ProviderEvent, { type: "tool_activity" }> {
  return { type: "tool_activity", phase: "updated", tool: { id, kind, name, ...patch } };
}

function compactTool(tool: ProviderToolActivity): ProviderToolActivity {
  if (tool.metadata && Object.keys(tool.metadata).length === 0) {
    const { metadata: _, ...rest } = tool;
    return rest;
  }
  return tool;
}

function normalizeStatus(status: string): string {
  return status.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function normalizeCollab(
  phase: "started" | "completed",
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }> | ForwardCollabItem,
): Extract<ProviderEvent, { type: "subagent_activity" }> {
  const operation = item.tool === "spawnAgent"
    ? "spawn_agent"
    : item.tool === "wait"
      ? "wait"
      : item.tool === "closeAgent"
        ? "close_agent"
        : "send_input";
  return {
    type: "subagent_activity",
    phase,
    operation,
    id: item.id,
    status: normalizeStatus(item.status),
    senderThreadId: item.senderThreadId,
    receiverThreadIds: item.receiverThreadIds,
    newThreadIds: operation === "spawn_agent" ? item.receiverThreadIds : [],
    prompt: item.prompt,
    agents: Object.fromEntries(
      Object.entries(item.agentsStates)
        .filter(
          (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined,
        )
        .map(([threadId, state]) => [
          threadId,
          { status: normalizeStatus(state.status), message: state.message },
        ]),
    ),
  };
}

function isCollabItem(
  item: unknown,
): item is Extract<ThreadItem, { type: "collabAgentToolCall" }> | ForwardCollabItem {
  if (!isRecord(item)) return false;
  if (item.type !== "collabAgentToolCall" && item.type !== "collabToolCall") return false;
  if (typeof item.id !== "string" || !COLLAB_TOOLS.has(String(item.tool))) return false;
  if (!COLLAB_STATUSES.has(String(item.status))) return false;
  if (typeof item.senderThreadId !== "string") return false;
  if (!Array.isArray(item.receiverThreadIds) || !item.receiverThreadIds.every((id) => typeof id === "string")) {
    return false;
  }
  if (item.prompt !== null && typeof item.prompt !== "string") return false;
  if (item.model !== null && typeof item.model !== "string") return false;
  if (item.reasoningEffort !== null && typeof item.reasoningEffort !== "string") return false;
  if (!isRecord(item.agentsStates)) return false;
  return Object.values(item.agentsStates).every((state) =>
    state === undefined || (
      isRecord(state) &&
      COLLAB_AGENT_STATUSES.has(String(state.status)) &&
      (state.message === null || typeof state.message === "string")
    ),
  );
}

const COLLAB_TOOLS = new Set(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"]);
const COLLAB_STATUSES = new Set(["inProgress", "completed", "failed"]);
const COLLAB_AGENT_STATUSES = new Set([
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
