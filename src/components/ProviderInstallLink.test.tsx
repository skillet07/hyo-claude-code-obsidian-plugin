import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { getProviderOnboarding } from "../provider-onboarding";
import { ProviderInstallLink } from "./ProviderInstallLink";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
});

describe("ProviderInstallLink", () => {
  it("renders the contextual official Codex installation URL visibly", () => {
    act(() => {
      renderer = create(<ProviderInstallLink onboarding={getProviderOnboarding("codex", "linux")} />);
    });
    const link = renderer!.root.findByType("a");
    expect(link.props.href).toBe("https://developers.openai.com/codex/cli");
    expect(link.children.join("")).toContain("Codex");
  });
});
