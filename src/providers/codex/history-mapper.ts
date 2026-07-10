import type { OrderedBlock, ToolCallData } from "../../chat-types";
import type {
  ProviderHistoryMessage,
  ProviderSessionSummary,
} from "../types";
import type { Thread } from "./generated/v2/Thread";
import type { ThreadItem } from "./generated/v2/ThreadItem";
import type { UserInput } from "./generated/v2/UserInput";
import {
  normalizeCollabToolCallItem,
  type NormalizedCollabToolCallItem,
} from "./collab-item";

const TITLE_LENGTH = 40;

export function mapThreadSummary(thread: Thread): ProviderSessionSummary {
  const timestamp = thread.recencyAt ?? thread.updatedAt ?? thread.createdAt;
  return {
    providerId: "codex",
    id: thread.id,
    title: thread.name?.trim() || fallbackTitle(thread.preview),
    date: new Date(timestamp * 1_000),
    providerState: { threadId: thread.id, currentTurnId: null },
  };
}

export function mapThreadHistory(thread: Thread): ProviderHistoryMessage[] {
  const messages: ProviderHistoryMessage[] = [];
  for (const turn of thread.turns) {
    const userParts: string[] = [];
    const assistantParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: ToolCallData[] = [];
    const orderedBlocks: OrderedBlock[] = [];

    for (const item of turn.items) {
      const collab = normalizeCollabToolCallItem(item);
      if (collab) {
        const tool = mapCollabToolCall(collab);
        toolCalls.push(tool);
        orderedBlocks.push({
          type: "tool",
          toolId: tool.id,
          turnIndex: 0,
          providerItemId: tool.id,
        });
        continue;
      }
      switch (item.type) {
        case "userMessage":
          userParts.push(...item.content.map(formatUserInput));
          break;
        case "hookPrompt":
          break;
        case "agentMessage":
          assistantParts.push(item.text);
          orderedBlocks.push({
            type: "text",
            content: item.text,
            turnIndex: 0,
            providerItemId: item.id,
          });
          break;
        case "reasoning": {
          const thinking = [...item.summary, ...item.content].join("\n");
          if (thinking) {
            thinkingParts.push(thinking);
            orderedBlocks.push({
              type: "thinking",
              content: thinking,
              turnIndex: 0,
              providerItemId: item.id,
            });
          }
          break;
        }
        case "plan":
          assistantParts.push(item.text);
          orderedBlocks.push({
            type: "text",
            content: item.text,
            turnIndex: 0,
            providerItemId: item.id,
          });
          break;
        case "contextCompaction":
        case "enteredReviewMode":
        case "exitedReviewMode":
        case "subAgentActivity":
          break;
        default: {
          const tool = mapToolCall(item);
          toolCalls.push(tool);
          orderedBlocks.push({
            type: "tool",
            toolId: tool.id,
            turnIndex: 0,
            providerItemId: tool.id,
          });
        }
      }
    }

    const turnStatus = turn.status === "failed" || turn.status === "interrupted"
      ? turn.status
      : undefined;
    const turnError = turn.error?.message;
    if (turnStatus) {
      const marker = turnStatus === "failed"
        ? `[Turn failed${turnError ? `: ${turnError}` : ""}]`
        : "[Turn interrupted]";
      assistantParts.push(marker);
      orderedBlocks.push({
        type: "text",
        content: marker,
        turnIndex: 0,
        providerItemId: `${turn.id}-status`,
      });
    }

    if (userParts.length > 0) {
      messages.push({ role: "user", content: userParts.filter(Boolean).join("\n") });
    }
    if (
      assistantParts.length > 0 ||
      thinkingParts.length > 0 ||
      toolCalls.length > 0
    ) {
      messages.push({
        role: "assistant",
        content: assistantParts.join("\n\n"),
        ...(turnStatus ? { turnStatus } : {}),
        ...(turnError ? { error: turnError } : {}),
        thinking: thinkingParts.join("\n\n"),
        toolCalls,
        orderedBlocks,
      });
    }
  }
  return messages;
}

function fallbackTitle(preview: string): string {
  const normalized = preview.replace(/\s+/g, " ").trim() || "New conversation";
  return normalized.length > TITLE_LENGTH
    ? `${normalized.slice(0, TITLE_LENGTH)}…`
    : normalized;
}

function formatUserInput(input: UserInput): string {
  switch (input.type) {
    case "text":
      return input.text;
    case "image":
      return "[Attached image]";
    case "localImage":
      return `[Local image: ${input.path}]`;
    case "skill":
      return `[Skill: ${input.name} — ${input.path}]`;
    case "mention":
      return `[Mention: ${input.name} — ${input.path}]`;
  }
}

function mapToolCall(item: Exclude<ThreadItem,
  | { type: "userMessage" }
  | { type: "hookPrompt" }
  | { type: "agentMessage" }
  | { type: "reasoning" }
  | { type: "plan" }
  | { type: "contextCompaction" }
  | { type: "enteredReviewMode" }
  | { type: "exitedReviewMode" }
  | { type: "subAgentActivity" }
>): ToolCallData {
  const raw = item as ThreadItem & Record<string, unknown>;
  switch (item.type) {
    case "commandExecution":
      return {
        id: item.id,
        name: "command",
        input: { command: item.command, cwd: item.cwd },
        result: item.aggregatedOutput,
      };
    case "fileChange":
      return {
        id: item.id,
        name: "file change",
        input: { changes: item.changes },
        result: item.status,
      };
    case "mcpToolCall":
      return {
        id: item.id,
        name: `${item.server}.${item.tool}`,
        input: item.arguments,
        result: stringifyResult(item.result ?? item.error),
      };
    case "dynamicToolCall":
      return {
        id: item.id,
        name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        input: item.arguments,
        result: stringifyResult(item.contentItems),
      };
    case "webSearch":
      return { id: item.id, name: "web search", input: { query: item.query }, result: stringifyResult(item.action) };
    case "imageView":
      return { id: item.id, name: "image view", input: { path: item.path }, result: null };
    case "sleep":
      return { id: item.id, name: "sleep", input: { durationMs: item.durationMs }, result: null };
    case "imageGeneration":
      return { id: item.id, name: "image generation", input: { revisedPrompt: item.revisedPrompt }, result: stringifyResult(item.result) };
    default:
      return {
        id: typeof raw.id === "string" ? raw.id : "unknown",
        name: typeof raw.type === "string" ? raw.type : "unknown",
        input: raw,
        result: null,
      };
  }
}

function mapCollabToolCall(item: NormalizedCollabToolCallItem): ToolCallData {
  return {
    id: item.id,
    name: item.operation,
    input: {
      prompt: item.prompt,
      receiverThreadIds: item.receiverThreadIds,
      newThreadIds: item.newThreadIds,
      agents: item.agents,
    },
    result: item.status,
  };
}

function stringifyResult(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
