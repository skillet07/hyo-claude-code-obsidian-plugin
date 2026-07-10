import { describe, expect, it } from "vitest";
import { mapThreadHistory, mapThreadSummary } from "./history-mapper";

describe("Codex history mapping", () => {
  it("uses a thread name and deterministic preview fallback for titles", () => {
    expect(mapThreadSummary({
      id: "named",
      name: "Renamed thread",
      preview: "ignored",
      updatedAt: 10,
      recencyAt: null,
      createdAt: 1,
    } as never).title).toBe("Renamed thread");
    expect(mapThreadSummary({
      id: "fallback",
      name: null,
      preview: "  First   message that is deliberately longer than forty characters  ",
      updatedAt: 10,
      recencyAt: null,
      createdAt: 1,
    } as never).title).toBe("First message that is deliberately longe…");
  });

  it("maps turn items without duplicating agent final text", () => {
    const history = mapThreadHistory({
      turns: [{
        id: "turn-1",
        status: "completed",
        error: null,
        itemsView: "full",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
          {
            type: "userMessage",
            id: "user-1",
            clientId: null,
            content: [
              { type: "text", text: "hello", text_elements: [] },
              { type: "localImage", path: "/tmp/image.png" },
            ],
          },
          { type: "reasoning", id: "reason-1", summary: ["Thought"], content: [] },
          { type: "agentMessage", id: "agent-1", text: "final answer", phase: null, memoryCitation: null },
          { type: "commandExecution", id: "tool-1", command: "pwd", cwd: "/tmp", processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "/tmp", exitCode: 0, durationMs: 1 },
        ],
      }],
    } as never);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      role: "user",
      content: "hello\n[Local image: /tmp/image.png]",
    });
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: "final answer",
      thinking: "Thought",
      toolCalls: [{ id: "tool-1", name: "command", input: { command: "pwd", cwd: "/tmp" }, result: "/tmp" }],
    });
    expect(history[1]?.orderedBlocks?.filter((block) => block.type === "text"))
      .toEqual([{ type: "text", content: "final answer", turnIndex: 0, providerItemId: "agent-1" }]);
  });
});
