import { describe, expect, it, vi } from "vitest";
import { clearComposerAfterAcceptedSend } from "./composer-send";

describe("clearComposerAfterAcceptedSend", () => {
  it("preserves the composer when a send is rejected", () => {
    const clear = vi.fn();

    clearComposerAfterAcceptedSend(false, clear);

    expect(clear).not.toHaveBeenCalled();
  });

  it("clears the composer when a send is accepted", () => {
    const clear = vi.fn();

    clearComposerAfterAcceptedSend(true, clear);

    expect(clear).toHaveBeenCalledOnce();
  });
});
