import type {
  ProviderContentBlock,
  ProviderEvent,
  ProviderQuestion,
} from "../types";

type RawClaudeEvent = any;

export class ClaudeEventNormalizer {
  private latestPlanContent: string | null = null;

  constructor(private readonly readPlan: () => string | null = () => null) {}

  normalize(raw: RawClaudeEvent): ProviderEvent[] {
    if (raw.type === "system" && raw.subtype === "init") {
      return raw.session_id
        ? [{ type: "session_metadata", sessionId: raw.session_id }]
        : [];
    }

    if (raw.type === "system" && raw.subtype === "compact_boundary") {
      return [{ type: "compaction_boundary" }];
    }

    if (raw.type === "system") return [];

    if (raw.type === "control_request") {
      return this.normalizeControlRequest(raw);
    }

    if (raw.type === "result") {
      const firstModel: any = Object.values(raw.modelUsage || {})[0];
      const contextWindow = firstModel?.contextWindow;
      return [{
        type: "turn_completed",
        ...(contextWindow ? { contextWindow } : {}),
      }];
    }

    if (raw.type === "assistant" || raw.type === "user") {
      return this.normalizeMessage(raw);
    }

    if (raw.type === "stream_event") {
      return this.normalizeStreamEvent(raw.event || raw);
    }

    if (raw.type === "error") {
      return [{ type: "error", message: String(raw.message || raw.error || "Unknown provider error") }];
    }

    return [];
  }

  normalizeError(message: string): ProviderEvent[] {
    return [{ type: "error", message }];
  }

  normalizeClose(exitCode: number | null): ProviderEvent[] {
    return [{ type: "closed", exitCode }];
  }

  private normalizeControlRequest(raw: RawClaudeEvent): ProviderEvent[] {
    const request = raw.request || {};
    const requestId = raw.request_id || "";
    const toolName = request.tool_name || "";
    const input = request.input || {};

    if (toolName === "AskUserQuestion") {
      const questions: ProviderQuestion[] =
        input.questions || [{ question: input.question }];
      return [{ type: "question_requested", requestId, questions }];
    }

    if (toolName === "ExitPlanMode") {
      return [{
        type: "plan_review_requested",
        requestId,
        planContent: this.latestPlanContent || this.readPlan(),
        allowedPrompts: input.allowedPrompts || [],
      }];
    }

    return [{
      type: "approval_requested",
      requestId,
      toolName,
      input: request.input,
      ...(toolName === "EnterPlanMode" ? { autoApprove: true } : {}),
    }];
  }

  private normalizeMessage(raw: RawClaudeEvent): ProviderEvent[] {
    const source = raw.type as "user" | "assistant";
    const blocks = this.normalizeBlocks(raw.message?.content || []);
    const events: ProviderEvent[] = [];

    if (blocks.length > 0) {
      events.push({ type: "content_blocks", source, blocks });
    }

    if (source === "assistant") {
      const ask = blocks.find(
        (block): block is Extract<ProviderContentBlock, { type: "tool_use" }> =>
          block.type === "tool_use" &&
          block.name === "AskUserQuestion" &&
          !!block.input?.questions,
      );
      if (ask) {
        events.push({
          type: "question_requested",
          requestId: ask.id,
          questions: ask.input.questions,
        });
      }

      const isSidechain = raw.isSidechain || raw.parent_tool_use_id;
      const usage = raw.message?.usage;
      if (usage && !isSidechain) {
        const inputTokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        if (inputTokens > 0) {
          events.push({ type: "token_usage", inputTokens });
        }
      }
    }

    return events;
  }

  private normalizeBlocks(rawBlocks: any[]): ProviderContentBlock[] {
    const blocks: ProviderContentBlock[] = [];
    for (const block of rawBlocks) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text || "" });
      } else if (block.type === "thinking") {
        blocks.push({ type: "thinking", thinking: block.thinking || "" });
      } else if (block.type === "tool_use") {
        const normalized: ProviderContentBlock = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
        blocks.push(normalized);
        if (block.name === "Write" && block.input?.content) {
          this.latestPlanContent = block.input.content;
        }
      } else if (block.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          toolUseId: block.tool_use_id,
          content: block.content,
        });
      }
    }
    return blocks;
  }

  private normalizeStreamEvent(raw: RawClaudeEvent): ProviderEvent[] {
    if (
      raw.type === "content_block_start" &&
      raw.content_block?.type === "tool_use"
    ) {
      return [{
        type: "tool_started",
        tool: {
          id: raw.content_block.id,
          name: raw.content_block.name,
          input: {},
        },
      }];
    }

    if (raw.type === "content_block_stop") {
      return [{ type: "tool_stopped" }];
    }

    if (raw.type !== "content_block_delta") return [];

    if (raw.delta?.type === "input_json_delta") {
      return [{ type: "tool_input_delta", delta: raw.delta.partial_json || "" }];
    }
    if (raw.delta?.type === "text_delta" && raw.delta.text) {
      return [{ type: "text_delta", delta: raw.delta.text }];
    }
    if (raw.delta?.type === "thinking_delta" && raw.delta.thinking) {
      return [{ type: "thinking_delta", delta: raw.delta.thinking }];
    }

    return [];
  }
}
