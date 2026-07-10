import { describe, expect, it, vi } from "vitest";
import type { ThreadItem } from "./generated/v2/ThreadItem";
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
      type: "agent_message_completed",
      itemId: "msg-1",
      text: "Hi there",
      replaceExisting: true,
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

  it("falls back safely when the forward collab alias is malformed", () => {
    expect(normalizer.normalize(lifecycle("started", {
      type: "collabToolCall", id: "bad-collab", tool: "spawnAgent",
    }) as never)).toEqual([{
      type: "tool_activity",
      phase: "started",
      tool: {
        id: "bad-collab", kind: "unknown", name: "collabToolCall",
        metadata: { itemType: "collabToolCall" },
      },
    }]);
    expect(normalizer.normalize(lifecycle("completed", {
      type: "collabToolCall", id: "changed-collab", tool: "wait", status: "completed",
      senderThreadId: "sender", receiverThreadIds: ["receiver"], prompt: null,
      model: null, reasoningEffort: null,
      agentsStates: { receiver: { status: "futureStatus", message: null } },
    }) as never)[0]).toMatchObject({
      type: "tool_activity",
      tool: { id: "changed-collab", kind: "unknown", name: "collabToolCall" },
    });
  });

  it("explicitly handles every current generated ThreadItem discriminator", () => {
    const item = <T extends ThreadItem>(value: T) => value;
    const items = {
      userMessage: item({ type: "userMessage", id: "user", clientId: null, content: [] }),
      hookPrompt: item({ type: "hookPrompt", id: "hook", fragments: [] }),
      agentMessage: item({ type: "agentMessage", id: "agent", text: "done", phase: null, memoryCitation: null }),
      plan: item({ type: "plan", id: "plan", text: "plan" }),
      reasoning: item({ type: "reasoning", id: "reason", summary: [], content: [] }),
      commandExecution: item({
        type: "commandExecution", id: "command", command: "pwd", cwd: "/vault",
        processId: null, source: "agent", status: "completed", commandActions: [],
        aggregatedOutput: null, exitCode: 0, durationMs: 1,
      }),
      fileChange: item({ type: "fileChange", id: "file", changes: [], status: "completed" }),
      mcpToolCall: item({
        type: "mcpToolCall", id: "mcp", server: "server", tool: "tool",
        status: "completed", arguments: {}, appContext: null, pluginId: null,
        result: null, error: null, durationMs: null,
      }),
      dynamicToolCall: item({
        type: "dynamicToolCall", id: "dynamic", namespace: null, tool: "tool",
        arguments: {}, status: "completed", contentItems: null, success: true,
        durationMs: null,
      }),
      collabAgentToolCall: item({
        type: "collabAgentToolCall", id: "collab", tool: "wait", status: "completed",
        senderThreadId: "sender", receiverThreadIds: [], prompt: null, model: null,
        reasoningEffort: null, agentsStates: {},
      }),
      subAgentActivity: item({
        type: "subAgentActivity", id: "subagent", kind: "interacted",
        agentThreadId: "agent-thread", agentPath: "root/agent",
      }),
      webSearch: item({ type: "webSearch", id: "web", query: "query", action: null }),
      imageView: item({ type: "imageView", id: "image", path: "/tmp/image.png" }),
      sleep: item({ type: "sleep", id: "sleep", durationMs: 100 }),
      imageGeneration: item({
        type: "imageGeneration", id: "generation", status: "completed",
        revisedPrompt: "prompt", result: "image-result", savedPath: "/tmp/generated.png",
      }),
      enteredReviewMode: item({ type: "enteredReviewMode", id: "review-in", review: "review" }),
      exitedReviewMode: item({ type: "exitedReviewMode", id: "review-out", review: "review" }),
      contextCompaction: item({ type: "contextCompaction", id: "compact" }),
    } satisfies { [K in ThreadItem["type"]]: Extract<ThreadItem, { type: K }> };

    const expected = {
      userMessage: "ignored", hookPrompt: "ignored",
      agentMessage: "agent_message_completed", plan: "plan_updated",
      reasoning: "reasoning_completed", commandExecution: "tool_activity",
      fileChange: "tool_activity", mcpToolCall: "tool_activity",
      dynamicToolCall: "tool_activity", collabAgentToolCall: "subagent_activity",
      subAgentActivity: "subagent_status", webSearch: "tool_activity",
      imageView: "tool_activity", sleep: "tool_activity",
      imageGeneration: "tool_activity", enteredReviewMode: "review_mode_changed",
      exitedReviewMode: "review_mode_changed", contextCompaction: "compaction_boundary",
    } satisfies Record<ThreadItem["type"], string>;

    for (const [kind, current] of Object.entries(items)) {
      const events = normalizer.normalize(lifecycle("completed", current) as never);
      if (expected[kind as ThreadItem["type"]] === "ignored") expect(events).toEqual([]);
      else {
        expect(events[0]?.type).toBe(expected[kind as ThreadItem["type"]]);
        expect(events).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "tool_activity", tool: { kind: "unknown" } }),
        ]));
      }
    }
  });

  it("reports unknown notification methods without exposing their payload", () => {
    const onUnknownNotification = vi.fn();
    const diagnosticNormalizer = new CodexEventNormalizer({ onUnknownNotification });

    expect(diagnosticNormalizer.normalize({
      method: "future/notification",
      params: { prompt: "sensitive", token: "secret" },
    })).toEqual([]);
    expect(onUnknownNotification).toHaveBeenCalledWith({ method: "future/notification" });
  });

  it("contains malformed known item lifecycle envelopes without payload leakage", () => {
    const onUnknownNotification = vi.fn();
    const diagnosticNormalizer = new CodexEventNormalizer({ onUnknownNotification });

    expect(diagnosticNormalizer.normalize({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1 },
    } as never)).toEqual([]);
    expect(diagnosticNormalizer.normalize({
      method: "item/completed",
      params: {
        threadId: "thread-1", turnId: "turn-1", completedAtMs: 2,
        item: { type: 42, prompt: "sensitive" },
      },
    } as never)).toEqual([]);
    expect(onUnknownNotification.mock.calls).toEqual([
      [{ method: "item/started" }],
      [{ method: "item/completed" }],
    ]);

    const throwingDiagnostic = new CodexEventNormalizer({
      onUnknownNotification: () => { throw new Error("diagnostic failed"); },
    });
    expect(() => throwingDiagnostic.normalize({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1 },
    } as never)).not.toThrow();
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
