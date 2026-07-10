export const HIDDEN_TOOLS = new Set([
  "TodoWrite",
  "TaskOutput",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
]);

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  displayText?: string;
  thinking?: string;
  toolCalls?: ToolCallData[];
  orderedBlocks?: OrderedBlock[];
  streaming?: boolean;
  permissionRequest?: PermissionRequestData | null;
  askQuestion?: AskQuestionData | null;
  planReview?: PlanReviewData | null;
  isCompaction?: boolean;
  attachments?: { type: string; name: string; preview?: string }[];
}

export interface ToolCallData {
  id: string;
  name: string;
  input: any;
  result: string | null;
  _inputJson?: string;
}

export interface OrderedBlock {
  type: "text" | "thinking" | "tool";
  content?: string;
  toolId?: string;
  turnIndex: number;
  isSkillOutput?: boolean;
  providerItemId?: string;
}

export interface PermissionRequestData {
  requestId: string;
  toolName: string;
  input?: any;
  resolved?: "allowed" | "denied";
}

export interface AskQuestionData {
  id: string;
  questions: ProviderQuestion[];
  answers: Record<string, string>;
}

export interface ProviderQuestion {
  id?: string;
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface PlanReviewData {
  requestId: string;
  planContent: string | null;
  allowedPrompts: { tool: string; prompt: string }[];
  resolved?: "approved" | "rejected";
}
