import { describe, expect, it } from "vitest";
import { normalizeModelId } from "./claude-transport";

describe("normalizeModelId", () => {
  it("removes the stale 1m suffix from Sonnet 5", () => {
    expect(normalizeModelId("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
  });

  it("leaves supported 1m model variants unchanged", () => {
    expect(normalizeModelId("claude-sonnet-4-6[1m]")).toBe(
      "claude-sonnet-4-6[1m]"
    );
  });

  it("does not mistake a later Sonnet generation for Sonnet 5", () => {
    expect(normalizeModelId("claude-sonnet-50[1m]")).toBe(
      "claude-sonnet-50[1m]"
    );
  });

  it("preserves a versioned Sonnet 5 ID while removing its stale suffix", () => {
    expect(normalizeModelId("claude-sonnet-5-20260701[1m]")).toBe(
      "claude-sonnet-5-20260701"
    );
  });
});
