import type {
  OrderedBlock,
  ProviderQuestion,
  ToolCallData,
} from "../chat-types";

export type { ProviderQuestion } from "../chat-types";

export type ProviderId = "claude" | "codex";

export interface ProviderCapabilities {
  approvals: boolean;
  questions: boolean;
  planReview: boolean;
  agents: boolean;
  sessionHistory: boolean;
  sessionRename: boolean;
  compaction: boolean;
  recovery: boolean;
  tokenUsage: boolean;
}

export interface ProviderSessionSummary {
  providerId: ProviderId;
  id: string;
  title: string;
  date: Date;
  size?: number;
  providerState?: unknown;
}

export interface ProviderHistoryMessage {
  role: "user" | "assistant";
  content: string;
  displayText?: string;
  attachments?: { type: string; name: string }[];
  thinking?: string;
  toolCalls?: ToolCallData[];
  orderedBlocks?: OrderedBlock[];
}

export type ProviderContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; toolUseId: string; content: unknown };

export type ProviderEvent =
  | { type: "session_metadata"; sessionId: string; providerState?: unknown }
  | { type: "compaction_boundary" }
  | {
      type: "content_blocks";
      source: "user" | "assistant";
      blocks: ProviderContentBlock[];
    }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_started"; tool: Omit<ToolCallData, "result"> }
  | { type: "tool_input_delta"; delta: string }
  | { type: "tool_stopped" }
  | {
      type: "approval_requested";
      requestId: string;
      toolName: string;
      input?: any;
      autoApprove?: boolean;
    }
  | {
      type: "question_requested";
      requestId: string;
      questions: ProviderQuestion[];
    }
  | {
      type: "plan_review_requested";
      requestId: string;
      planContent: string | null;
      allowedPrompts: { tool: string; prompt: string }[];
    }
  | { type: "token_usage"; inputTokens: number }
  | { type: "turn_completed"; contextWindow?: number }
  | { type: "error"; message: string }
  | { type: "closed"; exitCode: number | null };

export type ProviderApprovalBehavior = "allow" | "allow_always" | "deny";

export interface ProviderRuntimeOptions {
  cwd: string;
  model: string;
  permissionMode: string;
  agent?: string;
  providerSessionId?: string;
  resume?: boolean;
  maxOutputTokens?: number;
  onEvent: (event: ProviderEvent) => void;
}

export interface ProviderRuntime {
  readonly providerId: ProviderId;
  readonly ready: boolean;
  start(): void;
  isRunning(): boolean;
  send(content: string | any[]): void;
  interrupt(): void;
  respondApproval(
    requestId: string,
    behavior: ProviderApprovalBehavior,
    toolName?: string,
    updatedInput?: Record<string, unknown>,
  ): void;
  respondQuestion(
    requestId: string,
    questions: ProviderQuestion[],
    answers: Record<string, string>,
  ): void;
  compact(): void;
  cleanup(): void;
}

export interface ProviderRecoveryResult {
  success: boolean;
  linesRemoved: number;
  capturedUserText: string | null;
  reason?: string;
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  createRuntime(options: ProviderRuntimeOptions): ProviderRuntime;
  listSessions(cwd: string): ProviderSessionSummary[];
  loadSession(cwd: string, sessionId: string): ProviderHistoryMessage[];
  renameSession(cwd: string, sessionId: string, title: string): void;
  recoverSession(
    cwd: string,
    sessionId: string,
  ): ProviderRecoveryResult;
  generateTitle?(input: {
    userMessage: string;
    assistantMessage: string;
  }): Promise<string | null>;
  isRecoverableError?(message: string): boolean;
  normalizeModelId?(model: string): string;
  cleanup(): void;
}
