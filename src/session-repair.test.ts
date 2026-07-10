import { describe, expect, it } from "vitest";
import { isThinkingBlockApiError } from "./session-repair";

describe("isThinkingBlockApiError", () => {
  it("recognizes Claude's poisoned-session error", () => {
    expect(
      isThinkingBlockApiError(
        "messages.4.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified"
      )
    ).toBe(true);
  });

  it("ignores unrelated API errors", () => {
    expect(isThinkingBlockApiError("Request failed: rate limit exceeded")).toBe(
      false
    );
  });
});
