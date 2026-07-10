import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { ProviderEscapeTabs } from "./ProviderEscapeTabs";
import type { TabSession } from "../hooks/useSessionManager";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { if (renderer) act(() => renderer?.unmount()); renderer = undefined; });

function tab(id: string, providerId: "claude" | "codex"): TabSession {
  return {
    id, providerId, providerSessionId: null, providerState: null, title: `${providerId} tab`,
    messages: [], generating: false, model: "", permissionMode: "manual", agent: "",
    inputTokens: 0, voiceMode: false,
  };
}

describe("ProviderEscapeTabs", () => {
  it("lists only healthy existing provider tabs and switches without recreating them", () => {
    const onSwitch = vi.fn();
    act(() => {
      renderer = create(<ProviderEscapeTabs
        tabs={[tab("codex", "codex"), tab("claude", "claude")]}
        activeTabId="codex"
        providerHealthy={{ codex: false, claude: true }}
        onSwitch={onSwitch}
      />);
    });
    const buttons = renderer!.root.findAllByProps({ className: "hyo-provider-escape-tab" });
    expect(buttons.map((button) => button.children.join(""))).toEqual(["Claude · claude tab"]);
    act(() => buttons[0]!.props.onClick());
    expect(onSwitch).toHaveBeenCalledWith("claude");
  });
});
