import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { ChatTabs } from "./ChatTabs";
import type { TabSession } from "../hooks/useSessionManager";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
});

function tab(providerId: "claude" | "codex", id: string): TabSession {
  return {
    id,
    providerId,
    providerSessionId: null,
    providerState: null,
    title: "New conversation",
    messages: [],
    generating: false,
    model: "",
    permissionMode: "manual",
    agent: "",
    inputTokens: 0,
    voiceMode: false,
  };
}

describe("ChatTabs provider badges", () => {
  it("renders immutable Claude and Codex badges without a provider selector", () => {
    act(() => {
      renderer = create(<ChatTabs
        tabs={[tab("claude", "one"), tab("codex", "two")]}
        activeTabId="two"
        onSwitch={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        pastSessions={[]}
        onOpenPastSession={vi.fn()}
        onRefreshPastSessions={vi.fn()}
        onNewTab={vi.fn()}
      />);
    });

    const badges = renderer!.root.findAllByProps({ className: "hyo-provider-badge" });
    expect(badges.map((badge) => badge.children.join(""))).toEqual(["Claude", "Codex"]);
    expect(renderer!.root.findAllByProps({ className: "hyo-provider-selector" })).toHaveLength(0);
  });
});
