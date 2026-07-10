import { describe, expect, it } from "vitest";
import { ClaudeEventNormalizer } from "./event-normalizer";

describe("ClaudeEventNormalizer", () => {
  it("normalizes session metadata and streaming text, thinking, and tool lifecycle", () => {
    const normalizer = new ClaudeEventNormalizer();

    expect(
      normalizer.normalize({
        type: "system",
        subtype: "init",
        session_id: "session-1",
      }),
    ).toEqual([{ type: "session_metadata", sessionId: "session-1" }]);

    expect(
      normalizer.normalize({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Considering" },
        },
      }),
    ).toEqual([{ type: "thinking_delta", delta: "Considering" }]);

    expect(
      normalizer.normalize({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
      }),
    ).toEqual([{ type: "text_delta", delta: "Hello" }]);

    expect(
      normalizer.normalize({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "tool-1", name: "Read" },
        },
      }),
    ).toEqual([{ type: "tool_started", tool: { id: "tool-1", name: "Read", input: {} } }]);

    expect(
      normalizer.normalize({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"file_path":"a.md"}' },
        },
      }),
    ).toEqual([{ type: "tool_input_delta", delta: '{"file_path":"a.md"}' }]);

    expect(
      normalizer.normalize({
        type: "stream_event",
        event: { type: "content_block_stop" },
      }),
    ).toEqual([{ type: "tool_stopped" }]);
  });

  it("normalizes complete content and tool results without exposing Claude envelopes", () => {
    const normalizer = new ClaudeEventNormalizer();

    expect(
      normalizer.normalize({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.md" } },
          ],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 20,
          },
        },
      }),
    ).toEqual([
      {
        type: "content_blocks",
        source: "assistant",
        blocks: [
          { type: "text", text: "Reading" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.md" } },
        ],
      },
      { type: "token_usage", inputTokens: 35 },
    ]);

    expect(
      normalizer.normalize({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }],
        },
      }),
    ).toEqual([
      {
        type: "content_blocks",
        source: "user",
        blocks: [{ type: "tool_result", toolUseId: "tool-1", content: "contents" }],
      },
    ]);
  });

  it("normalizes approvals and AskUserQuestion requests", () => {
    const normalizer = new ClaudeEventNormalizer();

    expect(
      normalizer.normalize({
        type: "control_request",
        request_id: "permission-1",
        request: { tool_name: "Bash", input: { command: "pwd" } },
      }),
    ).toEqual([
      {
        type: "approval_requested",
        requestId: "permission-1",
        toolName: "Bash",
        input: { command: "pwd" },
      },
    ]);

    expect(
      normalizer.normalize({
        type: "control_request",
        request_id: "question-1",
        request: {
          tool_name: "AskUserQuestion",
          input: { questions: [{ question: "Choose?", options: [{ label: "A" }] }] },
        },
      }),
    ).toEqual([
      {
        type: "question_requested",
        requestId: "question-1",
        questions: [{ question: "Choose?", options: [{ label: "A" }] }],
      },
    ]);
  });

  it("normalizes plan review using plan content captured from the provider stream", () => {
    const normalizer = new ClaudeEventNormalizer(() => "fallback plan");
    normalizer.normalize({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "write-1",
            name: "Write",
            input: { file_path: ".claude/plan.md", content: "stream plan" },
          },
        ],
      },
    });

    expect(
      normalizer.normalize({
        type: "control_request",
        request_id: "plan-1",
        request: {
          tool_name: "ExitPlanMode",
          input: { allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] },
        },
      }),
    ).toEqual([
      {
        type: "plan_review_requested",
        requestId: "plan-1",
        planContent: "stream plan",
        allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
      },
    ]);
  });

  it("does not reuse Write content from a completed turn for a later plan review", () => {
    const normalizer = new ClaudeEventNormalizer(() => "current plan");
    normalizer.normalize({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "write-1",
            name: "Write",
            input: { file_path: "notes.md", content: "unrelated earlier write" },
          },
        ],
      },
    });
    normalizer.normalize({ type: "result" });

    expect(
      normalizer.normalize({
        type: "control_request",
        request_id: "plan-2",
        request: { tool_name: "ExitPlanMode", input: {} },
      }),
    ).toEqual([
      {
        type: "plan_review_requested",
        requestId: "plan-2",
        planContent: "current plan",
        allowedPrompts: [],
      },
    ]);
  });

  it("normalizes turn completion, provider errors, and process closure", () => {
    const normalizer = new ClaudeEventNormalizer();

    expect(
      normalizer.normalize({
        type: "result",
        modelUsage: { sonnet: { contextWindow: 200_000 } },
      }),
    ).toEqual([{ type: "turn_completed", contextWindow: 200_000 }]);
    expect(normalizer.normalizeError("boom")).toEqual([
      { type: "error", message: "boom" },
    ]);
    expect(normalizer.normalizeClose(1)).toEqual([
      { type: "closed", exitCode: 1 },
    ]);
  });
});
