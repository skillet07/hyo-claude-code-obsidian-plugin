import { describe, expect, it } from "vitest";
import { CodexEventNormalizer } from "./event-normalizer";

const lifecycle = (phase: "started" | "completed", item: Record<string, unknown>) => ({
  method: `item/${phase}`,
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    item,
    ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
  },
});

describe("CodexEventNormalizer", () => {
  const normalizer = new CodexEventNormalizer();

  it("normalizes agent message deltas and completion", () => {
    expect(normalizer.normalize({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "Hi" },
    })).toEqual([{ type: "text_delta", delta: "Hi", itemId: "msg-1" }]);

    expect(normalizer.normalize(lifecycle("completed", {
      type: "agentMessage",
      id: "msg-1",
      text: "Hi there",
      phase: null,
      memoryCitation: null,
    }) as never)).toEqual([{
      type: "content_blocks",
      source: "assistant",
      blocks: [{ type: "text", text: "Hi there" }],
    }]);
  });

  it("normalizes reasoning summary/text deltas and final content", () => {
    expect(normalizer.normalize({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "reason-1",
        delta: "Summary", summaryIndex: 0,
      },
    })).toEqual([{
      type: "thinking_delta", delta: "Summary", itemId: "reason-1",
      channel: "summary", index: 0,
    }]);
    expect(normalizer.normalize({
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "reason-1",
        delta: "Details", contentIndex: 1,
      },
    })).toEqual([{
      type: "thinking_delta", delta: "Details", itemId: "reason-1",
      channel: "content", index: 1,
    }]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "reasoning", id: "reason-1", summary: ["Summary"], content: ["Details"],
    }) as never)).toEqual([{
      type: "reasoning_completed", itemId: "reason-1",
      summary: ["Summary"], content: ["Details"],
    }]);
  });

  it("normalizes plan deltas, final plans, and turn plan updates", () => {
    expect(normalizer.normalize({
      method: "item/plan/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "Step" },
    })).toEqual([{ type: "plan_delta", itemId: "plan-1", delta: "Step" }]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "plan", id: "plan-1", text: "1. Step",
    }) as never)).toEqual([{
      type: "plan_updated", itemId: "plan-1", text: "1. Step", final: true,
    }]);
    expect(normalizer.normalize({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1", turnId: "turn-1", explanation: "Revised",
        plan: [{ step: "Step", status: "inProgress" }],
      },
    })).toEqual([{
      type: "plan_updated", explanation: "Revised",
      steps: [{ step: "Step", status: "in_progress" }], final: false,
    }]);
  });

  it("normalizes command output and completed status", () => {
    expect(normalizer.normalize({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "ok\n" },
    })).toEqual([{
      type: "tool_activity", phase: "updated",
      tool: { id: "cmd-1", kind: "command_execution", name: "command", outputDelta: "ok\n" },
    }]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "commandExecution", id: "cmd-1", command: "pwd", cwd: "/vault",
      processId: null, source: "agent", status: "completed", commandActions: [],
      aggregatedOutput: "/vault\n", exitCode: 0, durationMs: 4,
    }) as never)).toEqual([{
      type: "tool_activity", phase: "completed",
      tool: {
        id: "cmd-1", kind: "command_execution", name: "command", status: "completed",
        input: { command: "pwd", cwd: "/vault" }, output: "/vault\n",
        metadata: { exitCode: 0, durationMs: 4, processId: null },
      },
    }]);
  });

  it("normalizes file changes, patch updates, output, and status", () => {
    const changes = [{ path: "a.md", kind: "update", diff: "@@ -1 +1 @@" }];
    expect(normalizer.normalize({
      method: "item/fileChange/patchUpdated",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-1", changes },
    })).toEqual([{
      type: "tool_activity", phase: "updated",
      tool: { id: "file-1", kind: "file_change", name: "file change", changes },
    }]);
    expect(normalizer.normalize({
      method: "item/fileChange/outputDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-1", delta: "Done" },
    })).toEqual([{
      type: "tool_activity", phase: "updated",
      tool: { id: "file-1", kind: "file_change", name: "file change", outputDelta: "Done" },
    }]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "fileChange", id: "file-1", changes, status: "completed",
    }) as never)).toEqual([{
      type: "tool_activity", phase: "completed",
      tool: { id: "file-1", kind: "file_change", name: "file change", status: "completed", changes },
    }]);
  });

  it("normalizes MCP and dynamic tool calls", () => {
    expect(normalizer.normalize(lifecycle("started", {
      type: "mcpToolCall", id: "mcp-1", server: "github", tool: "search",
      status: "inProgress", arguments: { q: "codex" }, appContext: null,
      pluginId: null, result: null, error: null, durationMs: null,
    }) as never)).toEqual([{
      type: "tool_activity", phase: "started",
      tool: {
        id: "mcp-1", kind: "mcp_tool_call", name: "github.search", status: "in_progress",
        input: { q: "codex" }, metadata: { server: "github", pluginId: null },
      },
    }]);
    expect(normalizer.normalize({
      method: "item/mcpToolCall/progress",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "mcp-1", message: "Searching" },
    })).toEqual([{
      type: "tool_activity", phase: "updated",
      tool: { id: "mcp-1", kind: "mcp_tool_call", name: "MCP tool", outputDelta: "Searching" },
    }]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "mcpToolCall", id: "mcp-1", server: "github", tool: "search",
      status: "completed", arguments: { q: "codex" }, appContext: null,
      pluginId: "plugin-1",
      result: { content: [{ type: "text", text: "result" }], structuredContent: { count: 1 }, _meta: null },
      error: null, durationMs: 12,
    }) as never)).toEqual([{
      type: "tool_activity", phase: "completed",
      tool: {
        id: "mcp-1", kind: "mcp_tool_call", name: "github.search", status: "completed",
        input: { q: "codex" },
        output: { content: [{ type: "text", text: "result" }], structuredContent: { count: 1 }, _meta: null },
        metadata: { server: "github", pluginId: "plugin-1", durationMs: 12 },
      },
    }]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "dynamicToolCall", id: "dyn-1", namespace: "workspace", tool: "lookup",
      arguments: { key: "a" }, status: "completed", contentItems: [{ type: "inputText", text: "found" }],
      success: true, durationMs: 8,
    }) as never)).toEqual([{
      type: "tool_activity", phase: "completed",
      tool: {
        id: "dyn-1", kind: "dynamic_tool_call", name: "workspace.lookup", status: "completed",
        input: { key: "a" }, output: [{ type: "inputText", text: "found" }],
        metadata: { success: true, durationMs: 8 },
      },
    }]);
  });

  it("normalizes web searches and image views", () => {
    expect(normalizer.normalize(lifecycle("completed", {
      type: "webSearch", id: "web-1", query: "Codex", action: { type: "search", query: "Codex" },
    }) as never)).toEqual([{
      type: "tool_activity", phase: "completed",
      tool: { id: "web-1", kind: "web_search", name: "web search", input: { query: "Codex" }, output: { type: "search", query: "Codex" } },
    }]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "imageView", id: "image-1", path: "/tmp/a.png",
    }) as never)).toEqual([{
      type: "tool_activity", phase: "completed",
      tool: { id: "image-1", kind: "image_view", name: "image view", input: { path: "/tmp/a.png" } },
    }]);
  });

  it.each(["collabAgentToolCall", "collabToolCall"])(
    "normalizes %s lifecycle without exposing the Codex discriminator",
    (type) => {
      expect(normalizer.normalize(lifecycle("completed", {
        type, id: "collab-1", tool: "spawnAgent", status: "completed",
        senderThreadId: "thread-parent", receiverThreadIds: ["thread-child"],
        prompt: "Investigate", model: "gpt-5", reasoningEffort: "high",
        agentsStates: { "thread-child": { status: "completed", message: "Done" } },
      }) as never)).toEqual([{
        type: "subagent_activity", phase: "completed", operation: "spawn_agent",
        id: "collab-1", status: "completed", senderThreadId: "thread-parent",
        receiverThreadIds: ["thread-child"], newThreadIds: ["thread-child"],
        prompt: "Investigate",
        agents: { "thread-child": { status: "completed", message: "Done" } },
      }]);
    },
  );

  it.each([
    ["sendInput", "send_input"],
    ["resumeAgent", "send_input"],
    ["wait", "wait"],
    ["closeAgent", "close_agent"],
  ] as const)("maps %s to %s", (tool, operation) => {
    expect(normalizer.normalize(lifecycle("started", {
      type: "collabAgentToolCall", id: `collab-${tool}`, tool, status: "inProgress",
      senderThreadId: "sender", receiverThreadIds: ["receiver"], prompt: "prompt",
      model: null, reasoningEffort: null, agentsStates: {},
    }) as never)[0]).toMatchObject({ type: "subagent_activity", operation, phase: "started" });
  });

  it("normalizes nested collab agent status values", () => {
    expect(normalizer.normalize(lifecycle("started", {
      type: "collabAgentToolCall", id: "collab-wait", tool: "wait", status: "inProgress",
      senderThreadId: "sender", receiverThreadIds: ["receiver"], prompt: null,
      model: null, reasoningEffort: null,
      agentsStates: { receiver: { status: "pendingInit", message: null } },
    }) as never)[0]).toMatchObject({
      type: "subagent_activity",
      status: "in_progress",
      agents: { receiver: { status: "pending_init", message: null } },
    });
  });

  it("normalizes compaction, token usage, terminal turn states, warnings, and errors", () => {
    expect(normalizer.normalize({
      method: "thread/compacted", params: { threadId: "thread-1", turnId: "turn-1" },
    } as never)).toEqual([{ type: "compaction_boundary" }]);
    expect(normalizer.normalize({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1", turnId: "turn-1",
        tokenUsage: {
          total: { totalTokens: 33, inputTokens: 20, cachedInputTokens: 5, outputTokens: 13, reasoningOutputTokens: 3 },
          last: { totalTokens: 12, inputTokens: 7, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 },
          modelContextWindow: 200000,
        },
      },
    })).toEqual([{
      type: "token_usage", inputTokens: 20, outputTokens: 13,
      cachedInputTokens: 5, reasoningOutputTokens: 3, totalTokens: 33,
      contextWindow: 200000,
    }]);
    for (const status of ["completed", "interrupted", "failed"] as const) {
      expect(normalizer.normalize({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: `turn-${status}`, items: [], itemsView: { type: "full" }, status,
            error: status === "failed" ? { message: "boom", codexErrorInfo: null, additionalDetails: null } : null,
            startedAt: 1, completedAt: 2, durationMs: 1000,
          },
        },
      } as never)).toEqual([{
        type: "turn_completed", status,
        ...(status === "failed" ? { error: "boom" } : {}),
      }]);
    }
    expect(normalizer.normalize({
      method: "warning", params: { threadId: "thread-1", message: "Careful" },
    })).toEqual([{ type: "warning", message: "Careful" }]);
    expect(normalizer.normalize({
      method: "deprecationNotice", params: { summary: "Old setting", details: "Use the new setting" },
    })).toEqual([{ type: "warning", message: "Old setting: Use the new setting" }]);
    expect(normalizer.normalize({
      method: "configWarning", params: { summary: "Bad config", details: null, path: "/vault/config.toml" },
    })).toEqual([{ type: "warning", message: "Bad config" }]);
    expect(normalizer.normalize({
      method: "error",
      params: {
        threadId: "thread-1", turnId: "turn-1", willRetry: false,
        error: { message: "boom", codexErrorInfo: null, additionalDetails: "details" },
      },
    })).toEqual([{ type: "error", message: "boom", willRetry: false, details: "details" }]);
  });

  it("normalizes the stable contextCompaction item once on completion", () => {
    expect(normalizer.normalize(lifecycle("started", {
      type: "contextCompaction", id: "compact-1",
    }) as never)).toEqual([]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "contextCompaction", id: "compact-1",
    }) as never)).toEqual([{ type: "compaction_boundary" }]);
  });

  it("emits an unknown tool card instead of dropping an unknown item", () => {
    expect(normalizer.normalize(lifecycle("started", {
      type: "futureTool", id: "future-1", arbitrary: "wire-only",
    }) as never)).toEqual([{
      type: "tool_activity", phase: "started",
      tool: {
        id: "future-1", kind: "unknown", name: "futureTool",
        metadata: { itemType: "futureTool" },
      },
    }]);
  });
});
