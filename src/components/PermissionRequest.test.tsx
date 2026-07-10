import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { PermissionRequest } from "./PermissionRequest";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { if (renderer) act(() => renderer?.unmount()); renderer = undefined; });

describe("PermissionRequest", () => {
  it("preserves Claude's Allow once, Always allow, and Deny labels", () => {
    act(() => { renderer = create(<PermissionRequest request={{ requestId: "claude", toolName: "Bash", input: { command: "pwd" } }} onRespond={vi.fn()} />); });
    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain("Allow once");
    expect(json).toContain("Always allow");
    expect(json).toContain("Deny");
  });

  it("shows command and cwd and renders only the provider decisions", () => {
    const onRespond = vi.fn();
    act(() => { renderer = create(<PermissionRequest request={{
      requestId: "command-1", toolName: "command", approvalKind: "command_execution",
      input: { command: "npm test", cwd: "/vault/project" }, reason: "Run tests",
      availableDecisions: ["allow", "deny", "cancel"],
    }} onRespond={onRespond} />); });
    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain("npm test");
    expect(json).toContain("/vault/project");
    expect(json).toContain("Run tests");
    expect(json).not.toContain("Always allow");
    expect(json).toContain("Cancel");
  });

  it("renders each network amendment and returns the exact selected amendment", () => {
    const onRespond = vi.fn();
    const amendments = [{ host: "api.example.com", action: "allow" }, { host: "cdn.example.com", action: "deny" }];
    act(() => { renderer = create(<PermissionRequest request={{
      requestId: "network-1", toolName: "command", approvalKind: "command_execution",
      availableDecisions: ["apply_network_policy_amendment"],
      proposedAmendments: { networkPolicy: amendments },
    }} onRespond={onRespond} />); });
    const buttons = renderer!.root.findAllByType("button");
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].props.onClick());
    expect(onRespond).toHaveBeenCalledWith("network-1", {
      decision: "apply_network_policy_amendment",
      networkPolicyAmendment: amendments[1],
    });
  });
});
