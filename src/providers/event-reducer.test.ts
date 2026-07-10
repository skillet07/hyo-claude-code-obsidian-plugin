import { describe, expect, it } from "vitest";
import type { OrderedBlock } from "../chat-types";
import {
  applyAgentMessageCompletion,
  applyPlanDelta,
  applyPlanUpdate,
  applyProviderTextDelta,
  applyReasoningCompletion,
  createVisibleProviderWarning,
} from "./event-reducer";

describe("provider event reducer", () => {
  it("authoritatively replaces the matching agent item without duplicating another item", () => {
    const blocks: OrderedBlock[] = [];

    applyProviderTextDelta(blocks, 0, "message-a", "draft A");
    applyProviderTextDelta(blocks, 0, "message-b", "draft B");
    applyAgentMessageCompletion(blocks, 0, "message-b", "final B");
    applyAgentMessageCompletion(blocks, 0, "message-a", "final A");

    expect(blocks).toEqual([
      {
        type: "text", content: "final A", turnIndex: 0,
        providerItemId: "message-a",
      },
      {
        type: "text", content: "final B", turnIndex: 0,
        providerItemId: "message-b",
      },
    ]);
  });
});

describe("normalized Codex rich events", () => {
  it("creates a visible assistant warning before any turn stream exists", () => {
    expect(createVisibleProviderWarning("Startup config warning")).toMatchObject({
      role: "assistant",
      streaming: false,
      content: expect.stringContaining("Startup config warning"),
      orderedBlocks: [expect.objectContaining({
        type: "text",
        content: expect.stringContaining("Startup config warning"),
      })],
    });
  });

  it("streams one plan card and replaces it with the authoritative final plan", () => {
    const blocks: OrderedBlock[] = [];
    applyPlanDelta(blocks, 0, "plan-1", "Draft");
    applyPlanDelta(blocks, 0, "plan-1", " plan");
    applyPlanUpdate(blocks, 0, { itemId: "plan-1", text: "Final plan", final: true });
    expect(blocks).toEqual([{ type: "text", content: "### Plan\n\nFinal plan", turnIndex: 0, providerItemId: "plan:plan-1" }]);
  });

  it("reconciles turn plan updates with a later item final without duplicate cards", () => {
    const blocks: OrderedBlock[] = [];
    applyPlanUpdate(blocks, 0, { steps: [{ step: "Draft step", status: "pending" }], final: false });
    applyPlanUpdate(blocks, 0, { itemId: "plan-final", text: "Authoritative", final: true });
    expect(blocks.filter((block) => block.providerItemId?.startsWith("plan:"))).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ providerItemId: "plan:plan-final", content: "### Plan\n\nAuthoritative" });
  });

  it("prefers final reasoning summary and replaces incomplete deltas by item id", () => {
    const blocks: OrderedBlock[] = [{ type: "thinking", content: "partial", turnIndex: 0, providerItemId: "reason-1" }];
    applyReasoningCompletion(blocks, 0, "reason-1", ["Summary"], ["raw details"]);
    expect(blocks[0].content).toBe("Summary");
  });
});
