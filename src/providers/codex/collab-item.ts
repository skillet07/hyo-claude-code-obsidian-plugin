import type { ThreadItem } from "./generated/v2/ThreadItem";

type LegacyCollabToolCallItem = Extract<
  ThreadItem,
  { type: "collabAgentToolCall" }
>;

export interface StableCollabToolCallItem {
  type: "collabToolCall";
  id: string;
  tool: string;
  status: string;
  senderThreadId: string;
  receiverThreadId?: string | null;
  newThreadId?: string | null;
  prompt?: string | null;
  agentStatus?: unknown;
}

export interface NormalizedCollabToolCallItem {
  id: string;
  operation: "spawn_agent" | "send_input" | "wait" | "close_agent";
  status: string;
  senderThreadId: string;
  receiverThreadIds: string[];
  newThreadIds: string[];
  prompt: string | null;
  agents: Record<string, { status: string; message: string | null }>;
}

export function normalizeCollabToolCallItem(
  item: unknown,
): NormalizedCollabToolCallItem | null {
  if (!isRecord(item)) return null;
  if (item.type === "collabAgentToolCall") {
    return isLegacyCollabToolCallItem(item) ? normalizeLegacy(item) : null;
  }
  if (item.type === "collabToolCall") {
    return isStableCollabToolCallItem(item) ? normalizeStable(item) : null;
  }
  return null;
}

export function isStableCollabToolCallItem(
  item: unknown,
): item is StableCollabToolCallItem {
  if (!isRecord(item) || item.type !== "collabToolCall") return false;
  if (typeof item.id !== "string") return false;
  if (normalizeCollabOperation(item.tool) === null) return false;
  if (!isCollabCallStatus(item.status)) return false;
  if (typeof item.senderThreadId !== "string") return false;
  if (!isOptionalNullableString(item.receiverThreadId)) return false;
  if (!isOptionalNullableString(item.newThreadId)) return false;
  if (!isOptionalNullableString(item.prompt)) return false;
  return true;
}

export function normalizeCollabOperation(
  tool: unknown,
): NormalizedCollabToolCallItem["operation"] | null {
  switch (tool) {
    case "spawn_agent":
    case "spawnAgent":
      return "spawn_agent";
    case "send_input":
    case "sendInput":
    case "resume_agent":
    case "resumeAgent":
      return "send_input";
    case "wait":
      return "wait";
    case "close_agent":
    case "closeAgent":
      return "close_agent";
    default:
      return null;
  }
}

function normalizeStable(
  item: StableCollabToolCallItem,
): NormalizedCollabToolCallItem {
  const operation = normalizeCollabOperation(item.tool)!;
  const receiverThreadIds = uniqueStrings([
    item.receiverThreadId,
    operation === "spawn_agent" ? item.newThreadId : undefined,
  ]);
  const newThreadIds = operation === "spawn_agent"
    ? uniqueStrings([item.newThreadId])
    : [];
  const agentThreadId = item.newThreadId ?? item.receiverThreadId ?? null;
  const agent = normalizeStableAgentStatus(item.agentStatus);
  return {
    id: item.id,
    operation,
    status: normalizeWireName(item.status),
    senderThreadId: item.senderThreadId,
    receiverThreadIds,
    newThreadIds,
    prompt: item.prompt ?? null,
    agents: agent && agentThreadId ? { [agentThreadId]: agent } : {},
  };
}

function normalizeLegacy(
  item: LegacyCollabToolCallItem,
): NormalizedCollabToolCallItem {
  const operation = normalizeCollabOperation(item.tool)!;
  return {
    id: item.id,
    operation,
    status: normalizeWireName(item.status),
    senderThreadId: item.senderThreadId,
    receiverThreadIds: item.receiverThreadIds,
    newThreadIds: operation === "spawn_agent" ? item.receiverThreadIds : [],
    prompt: item.prompt,
    agents: Object.fromEntries(
      Object.entries(item.agentsStates)
        .filter(
          (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
            entry[1] !== undefined,
        )
        .map(([threadId, state]) => [
          threadId,
          { status: normalizeWireName(state.status), message: state.message },
        ]),
    ),
  };
}

function isLegacyCollabToolCallItem(
  item: Record<string, unknown>,
): item is LegacyCollabToolCallItem {
  if (typeof item.id !== "string" || normalizeCollabOperation(item.tool) === null) {
    return false;
  }
  if (!isCollabCallStatus(item.status) || typeof item.senderThreadId !== "string") {
    return false;
  }
  if (!Array.isArray(item.receiverThreadIds) ||
    !item.receiverThreadIds.every((id) => typeof id === "string")) {
    return false;
  }
  if (item.prompt !== null && typeof item.prompt !== "string") return false;
  if (item.model !== null && typeof item.model !== "string") return false;
  if (item.reasoningEffort !== null && typeof item.reasoningEffort !== "string") {
    return false;
  }
  if (!isRecord(item.agentsStates)) return false;
  return Object.values(item.agentsStates).every((state) =>
    state === undefined || (
      isRecord(state) &&
      typeof state.status === "string" &&
      COLLAB_AGENT_STATUSES.has(normalizeWireName(state.status)) &&
      (state.message === null || typeof state.message === "string")
    ),
  );
}

function normalizeStableAgentStatus(
  value: unknown,
): { status: string; message: string | null } | null {
  const rawStatus = typeof value === "string"
    ? value
    : isRecord(value)
      ? typeof value.status === "string"
        ? value.status
        : typeof value.type === "string"
          ? value.type
          : null
      : null;
  if (rawStatus === null) return null;
  const status = normalizeWireName(rawStatus);
  if (!COLLAB_AGENT_STATUSES.has(status)) return null;
  const message = isRecord(value) && typeof value.message === "string"
    ? value.message
    : null;
  return { status, message };
}

function isCollabCallStatus(status: unknown): status is string {
  return typeof status === "string" &&
    COLLAB_CALL_STATUSES.has(normalizeWireName(status));
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function normalizeWireName(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

const COLLAB_CALL_STATUSES = new Set(["in_progress", "completed", "failed"]);
const COLLAB_AGENT_STATUSES = new Set([
  "pending_init",
  "running",
  "interrupted",
  "completed",
  "errored",
  "failed",
  "shutdown",
  "not_found",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
