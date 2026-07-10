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
  models: boolean;
  skills: boolean;
  rateLimits: boolean;
  auth: boolean;
}

export interface ProviderModelEffort {
  id: string;
  description: string;
}

export interface ProviderModelInfo {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultEffort: string;
  effortOptions: ProviderModelEffort[];
  inputModalities: string[];
  supportsPersonality: boolean;
}

export interface ProviderSkillInfo {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
  cwd: string;
}

export interface ProviderRateLimitWindow {
  usedPercent: number;
  resetsAt: Date | null;
  windowMinutes: number | null;
}

export interface ProviderRateLimitInfo {
  id: string | null;
  name: string | null;
  primary: ProviderRateLimitWindow | null;
  secondary: ProviderRateLimitWindow | null;
}

export interface ProviderRateLimits {
  default: ProviderRateLimitInfo;
  byId: Record<string, ProviderRateLimitInfo>;
}

export interface ProviderAuthState {
  authenticated: boolean;
  requiresAuth: boolean;
  accountType: string | null;
  email?: string | null;
  plan?: string | null;
}

export type ProviderLoginMethod = "browser" | "device";

export type ProviderLoginStartResult =
  | { type: "browser"; loginId: string; url: string }
  | { type: "device"; loginId: string; url: string; userCode: string }
  | { type: "complete" };

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

export type ProviderToolKind =
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "web_search"
  | "image_view"
  | "sleep"
  | "image_generation"
  | "unknown";

export interface ProviderToolActivity {
  id: string;
  kind: ProviderToolKind;
  name: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  outputDelta?: string;
  changes?: Array<{ path: string; kind: string; diff: string }>;
  metadata?: Record<string, unknown>;
}

export type ProviderApprovalKind =
  | "command_execution"
  | "file_change"
  | "permissions";

export type ProviderApprovalDecision =
  | "allow"
  | "allow_session"
  | "allow_execpolicy_amendment"
  | "apply_network_policy_amendment"
  | "deny"
  | "cancel";

export type ProviderEvent =
  | { type: "session_metadata"; sessionId: string; providerState?: unknown }
  | { type: "compaction_boundary" }
  | {
      type: "content_blocks";
      source: "user" | "assistant";
      blocks: ProviderContentBlock[];
    }
  | { type: "text_delta"; delta: string; itemId?: string }
  | {
      type: "agent_message_completed";
      itemId: string;
      text: string;
      replaceExisting: true;
    }
  | {
      type: "thinking_delta";
      delta: string;
      itemId?: string;
      channel?: "summary" | "content";
      index?: number;
    }
  | {
      type: "reasoning_completed";
      itemId: string;
      summary: string[];
      content: string[];
    }
  | { type: "plan_delta"; itemId: string; delta: string }
  | {
      type: "plan_updated";
      itemId?: string;
      text?: string;
      explanation?: string | null;
      steps?: Array<{ step: string; status: string }>;
      final: boolean;
    }
  | {
      type: "tool_activity";
      phase: "started" | "updated" | "completed";
      tool: ProviderToolActivity;
    }
  | {
      type: "subagent_activity";
      phase: "started" | "completed";
      operation: "spawn_agent" | "send_input" | "wait" | "close_agent";
      id: string;
      status: string;
      senderThreadId: string;
      receiverThreadIds: string[];
      newThreadIds: string[];
      prompt: string | null;
      agents: Record<string, { status: string; message: string | null }>;
    }
  | {
      type: "subagent_status";
      phase: "started" | "completed";
      id: string;
      activity: "started" | "interacted" | "interrupted";
      agentThreadId: string;
      agentPath: string;
    }
  | {
      type: "review_mode_changed";
      itemId: string;
      active: boolean;
      review: string;
    }
  | { type: "tool_started"; tool: Omit<ToolCallData, "result"> }
  | { type: "tool_input_delta"; delta: string }
  | { type: "tool_stopped" }
  | {
      type: "approval_requested";
      requestId: string;
      toolName: string;
      input?: any;
      autoApprove?: boolean;
      approvalKind?: ProviderApprovalKind;
      threadId?: string;
      turnId?: string;
      itemId?: string;
      reason?: string | null;
      availableDecisions?: ProviderApprovalDecision[];
      proposedAmendments?: {
        execpolicy?: string[] | null;
        networkPolicy?: Array<{ host: string; action: string }> | null;
      };
      grantScopes?: Array<"turn" | "session">;
    }
  | {
      type: "question_requested";
      requestId: string;
      questions: ProviderQuestion[];
      threadId?: string;
      turnId?: string;
      itemId?: string;
      autoResolutionMs?: number | null;
    }
  | {
      type: "plan_review_requested";
      requestId: string;
      planContent: string | null;
      allowedPrompts: { tool: string; prompt: string }[];
    }
  | {
      type: "request_resolved";
      requestId: string;
      reason: "server" | "auto";
    }
  | {
      type: "token_usage";
      inputTokens: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      totalTokens?: number;
      contextWindow?: number;
    }
  | {
      type: "turn_completed";
      contextWindow?: number;
      status?: "completed" | "interrupted" | "failed";
      error?: string;
    }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; willRetry?: boolean; details?: string | null }
  | { type: "closed"; exitCode: number | null };

export type ProviderApprovalBehavior = "allow" | "allow_always" | "deny";

export interface ProviderRuntimeOptions {
  cwd: string;
  model: string;
  permissionMode: string;
  agent?: string;
  providerSessionId?: string;
  providerState?: unknown;
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
  listSessions(cwd: string): Promise<ProviderSessionSummary[]>;
  loadSession(cwd: string, sessionId: string): Promise<ProviderHistoryMessage[]>;
  renameSession(cwd: string, sessionId: string, title: string): Promise<void>;
  recoverSession(
    cwd: string,
    sessionId: string,
  ): Promise<ProviderRecoveryResult>;
  listModels?(): Promise<ProviderModelInfo[]>;
  listSkills?(cwd: string): Promise<ProviderSkillInfo[]>;
  getRateLimits?(): Promise<ProviderRateLimits>;
  getAuthState?(refreshToken?: boolean): Promise<ProviderAuthState>;
  startLogin?(method: ProviderLoginMethod): Promise<ProviderLoginStartResult>;
  cancelLogin?(loginId: string): Promise<void>;
  generateTitle?(input: {
    userMessage: string;
    assistantMessage: string;
  }): Promise<string | null>;
  isRecoverableError?(message: string): boolean;
  normalizeModelId?(model: string): string;
  cleanup(): void;
}
