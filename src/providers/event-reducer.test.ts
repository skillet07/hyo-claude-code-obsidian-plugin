import { describe, expect, it } from "vitest";
import type { OrderedBlock } from "../chat-types";
import {
  applyAgentMessageCompletion,
  applyProviderTextDelta,
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
