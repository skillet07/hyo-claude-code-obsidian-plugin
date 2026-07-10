import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { CodexStatusControls } from "./CodexStatusControls";
import type { ChatProvider, ProviderSessionOptions } from "../providers/types";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).open = vi.fn();
  (globalThis as any).confirm = vi.fn();
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});

function provider(overrides: Partial<ChatProvider> = {}): ChatProvider {
  return {
    id: "codex",
    capabilities: {
      approvals: true, questions: true, planReview: false, agents: true,
      sessionHistory: true, sessionRename: true, compaction: true, recovery: false,
      tokenUsage: true, models: true, skills: true, rateLimits: true, auth: true,
    },
    createRuntime: vi.fn(),
    listSessions: vi.fn(async () => []),
    loadSession: vi.fn(async () => []),
    renameSession: vi.fn(async () => undefined),
    recoverSession: vi.fn(async () => ({ success: false, linesRemoved: 0, capturedUserText: null })),
    cleanup: vi.fn(),
    listModels: vi.fn(async () => [{
      id: "gpt-5.2-codex", displayName: "GPT-5.2 Codex", description: "",
      isDefault: true, defaultEffort: "medium",
      effortOptions: [{ id: "low", description: "Fast" }, { id: "high", description: "Deep" }],
      inputModalities: ["text"], supportsPersonality: false,
    }]),
    getAuthState: vi.fn(async () => ({
      authenticated: false, requiresAuth: true, accountType: null,
    })),
    getRateLimits: vi.fn(async () => ({
      default: {
        id: null, name: null,
        primary: { usedPercent: 25, resetsAt: null, windowMinutes: 300 },
        secondary: null,
      },
      byId: {},
    })),
    ...overrides,
  } as ChatProvider;
}

async function mount(
  codex: ChatProvider,
  callbacks: Record<string, any> = {},
  optionOverrides: Partial<ProviderSessionOptions> = {},
) {
  await act(async () => {
    renderer = create(controls(codex, callbacks, optionOverrides));
    await Promise.resolve();
  });
}

function controls(
  codex: ChatProvider,
  callbacks: Record<string, any> = {},
  optionOverrides: Partial<ProviderSessionOptions> = {},
) {
  return <CodexStatusControls
      provider={codex}
      options={{
        model: "", reasoningEffort: undefined, approvalPolicy: "on-request",
        sandboxMode: "workspace-write", networkAccess: false,
        ...optionOverrides,
      }}
      onModelChange={callbacks.model ?? vi.fn()}
      onReasoningEffortChange={callbacks.effort ?? vi.fn()}
      onApprovalPolicyChange={callbacks.approval ?? vi.fn()}
      onSandboxModeChange={callbacks.sandbox ?? vi.fn()}
      onNetworkAccessChange={callbacks.network ?? vi.fn()}
    />;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("CodexStatusControls", () => {
  it("loads the dynamic model catalog and supported efforts", async () => {
    await mount(provider());
    const model = renderer!.root.findByProps({ "aria-label": "Codex model" });
    const effort = renderer!.root.findByProps({ "aria-label": "Codex reasoning effort" });
    expect(model.findAllByType("option").map((option) => option.props.value))
      .toEqual(["", "gpt-5.2-codex"]);
    expect(effort.findAllByType("option").map((option) => option.props.value))
      .toEqual(["", "low", "high"]);
    expect(renderer!.root.findByProps({ className: "hyo-codex-usage" }).children.join(""))
      .toBe("25% used");
  });

  it("exposes ChatGPT browser and device login without an API-key field", async () => {
    const startLogin = vi.fn(async (method: "browser" | "device") => method === "browser"
      ? { type: "browser" as const, loginId: "login", url: "https://login" }
      : { type: "device" as const, loginId: "device", url: "https://device", userCode: "CODE" });
    const open = vi.mocked(globalThis.open);
    await mount(provider({ startLogin }));
    const loginButtons = renderer!.root.findAllByProps({ className: "hyo-codex-login" });
    expect(loginButtons.map((button) => button.children.join(""))).toEqual([
      "Log in with ChatGPT", "Use device code",
    ]);
    expect(renderer!.root.findAllByProps({ type: "password" })).toHaveLength(0);
    await act(async () => loginButtons[0]!.props.onClick());
    expect(startLogin).toHaveBeenCalledWith("browser");
    expect(open).toHaveBeenCalledWith("https://login", "_blank", "noopener");
  });

  it("keeps login available when unauthenticated metadata calls fail", async () => {
    await mount(provider({
      listModels: vi.fn(async () => { throw new Error("login required"); }),
      getRateLimits: vi.fn(async () => { throw new Error("login required"); }),
    }));

    expect(renderer!.root.findAllByProps({ className: "hyo-codex-login" }))
      .toHaveLength(2);
  });

  it("updates network access and confirms danger-full-access explicitly", async () => {
    const callbacks = { network: vi.fn(), sandbox: vi.fn() };
    await mount(provider(), callbacks);
    act(() => renderer!.root.findByProps({ "aria-label": "Codex network access" }).props.onChange({ target: { checked: true } }));
    expect(callbacks.network).toHaveBeenCalledWith(true);

    const confirm = vi.mocked(globalThis.confirm).mockReturnValue(false);
    act(() => renderer!.root.findByProps({ "aria-label": "Codex sandbox mode" }).props.onChange({ target: { value: "danger-full-access" } }));
    expect(confirm).toHaveBeenCalled();
    expect(callbacks.sandbox).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    act(() => renderer!.root.findByProps({ "aria-label": "Codex sandbox mode" }).props.onChange({ target: { value: "danger-full-access" } }));
    expect(callbacks.sandbox).toHaveBeenCalledWith("danger-full-access");
  });

  it("clears a reasoning effort unsupported by the newly selected model", async () => {
    const callbacks = { model: vi.fn(), effort: vi.fn() };
    await mount(provider({
      listModels: vi.fn(async () => [
        {
          id: "model-a", displayName: "Model A", description: "", isDefault: true,
          defaultEffort: "high", effortOptions: [{ id: "high", description: "" }],
          inputModalities: ["text"], supportsPersonality: false,
        },
        {
          id: "model-b", displayName: "Model B", description: "", isDefault: false,
          defaultEffort: "low", effortOptions: [{ id: "low", description: "" }],
          inputModalities: ["text"], supportsPersonality: false,
        },
      ]),
    }), callbacks, { model: "model-a", reasoningEffort: "high" });

    act(() => renderer!.root.findByProps({ "aria-label": "Codex model" }).props.onChange({
      target: { value: "model-b" },
    }));
    expect(callbacks.effort).toHaveBeenCalledWith(undefined);
    expect(callbacks.model).toHaveBeenCalledWith("model-b");
  });

  it("renders authenticated ChatGPT account details without secrets", async () => {
    await mount(provider({
      getAuthState: vi.fn(async () => ({
        authenticated: true,
        requiresAuth: true,
        accountType: "chatgpt",
        email: "user@example.com",
        plan: "plus",
      })),
    }));

    const status = renderer!.root.findByProps({ className: "hyo-codex-account" });
    expect(status.children.join("")).toContain("chatgpt");
    expect(status.children.join("")).toContain("user@example.com");
    expect(status.children.join("")).toContain("plus");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("token");
  });

  it("ignores out-of-order metadata from a replaced provider and resets old state", async () => {
    const oldModels = deferred<any[]>();
    const old = provider({ listModels: vi.fn(() => oldModels.promise) });
    const next = provider({
      listModels: vi.fn(async () => [{
        id: "new-model", displayName: "New Model", description: "", isDefault: true,
        defaultEffort: "low", effortOptions: [{ id: "low", description: "" }],
        inputModalities: ["text"], supportsPersonality: false,
      }]),
    });
    await mount(old);
    await act(async () => {
      renderer!.update(controls(next));
      await Promise.resolve();
    });
    expect(renderer!.root.findByProps({ "aria-label": "Codex model" })
      .findAllByType("option").map((option) => option.props.value))
      .toEqual(["", "new-model"]);

    await act(async () => {
      oldModels.resolve([{
        id: "old-model", displayName: "Old Model", description: "", isDefault: true,
        defaultEffort: "high", effortOptions: [], inputModalities: ["text"],
        supportsPersonality: false,
      }]);
      await oldModels.promise;
    });
    expect(renderer!.root.findByProps({ "aria-label": "Codex model" })
      .findAllByType("option").map((option) => option.props.value))
      .toEqual(["", "new-model"]);
  });

  it("reconciles unsupported persisted effort after catalog load but preserves unknown models", async () => {
    const effort = vi.fn();
    const catalog = provider({
      listModels: vi.fn(async () => [{
        id: "known", displayName: "Known", description: "", isDefault: true,
        defaultEffort: "low", effortOptions: [{ id: "low", description: "" }],
        inputModalities: ["text"], supportsPersonality: false,
      }]),
    });
    await mount(catalog, { effort }, { model: "known", reasoningEffort: "high" });
    expect(effort).toHaveBeenCalledWith(undefined);

    effort.mockClear();
    await act(async () => {
      renderer!.update(controls(catalog, { effort }, {
        model: "custom-not-listed", reasoningEffort: "high",
      }));
      await Promise.resolve();
    });
    expect(effort).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.update(controls(catalog, { effort }, {
        model: "known", reasoningEffort: "high",
      }));
      await Promise.resolve();
    });
    expect(effort).toHaveBeenCalledWith(undefined);
  });

  it("prevents duplicate login starts and supports explicit cancel", async () => {
    const pending = deferred<any>();
    const cancelLogin = vi.fn(async () => undefined);
    const codex = provider({
      startLogin: vi.fn(() => pending.promise),
      cancelLogin,
    });
    await mount(codex);
    const browser = renderer!.root.findAllByProps({ className: "hyo-codex-login" })[0]!;
    act(() => { browser.props.onClick(); browser.props.onClick(); });
    expect(codex.startLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ type: "browser", loginId: "login-1", url: "https://login" });
      await pending.promise;
    });
    const cancel = renderer!.root.findByProps({ className: "hyo-codex-login-cancel" });
    await act(async () => cancel.props.onClick());
    expect(cancelLogin).toHaveBeenCalledWith("login-1");
  });

  it("cancels a late login result owned by a replaced provider", async () => {
    const pending = deferred<any>();
    const cancelLogin = vi.fn(async () => undefined);
    const old = provider({ startLogin: vi.fn(() => pending.promise), cancelLogin });
    const next = provider();
    await mount(old);
    act(() => renderer!.root.findAllByProps({ className: "hyo-codex-login" })[0]!.props.onClick());
    await act(async () => {
      renderer!.update(controls(next));
      await Promise.resolve();
    });
    await act(async () => {
      pending.resolve({ type: "browser", loginId: "old-login", url: "https://old" });
      await pending.promise;
    });
    expect(cancelLogin).toHaveBeenCalledWith("old-login");
    expect(globalThis.open).not.toHaveBeenCalledWith("https://old", expect.anything(), expect.anything());
  });

  it("stops failed login polling and exposes Retry instead of polling forever", async () => {
    vi.useFakeTimers();
    try {
      const getAuthState = vi.fn()
        .mockResolvedValueOnce({ authenticated: false, requiresAuth: true, accountType: null })
        .mockRejectedValue(new Error("poll failed"));
      const codex = provider({
        getAuthState,
        startLogin: vi.fn(async () => ({
          type: "device" as const, loginId: "device", url: "https://device", userCode: "CODE",
        })),
        cancelLogin: vi.fn(async () => undefined),
      });
      await mount(codex);
      await act(async () => renderer!.root.findAllByProps({ className: "hyo-codex-login" })[1]!.props.onClick());
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(renderer!.root.findByProps({ className: "hyo-codex-login-retry" })).toBeTruthy();
      const callsAfterFailure = getAuthState.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(getAuthState).toHaveBeenCalledTimes(callsAfterFailure);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and cancels a pending login after ten minutes", async () => {
    vi.useFakeTimers();
    try {
      const cancelLogin = vi.fn(async () => undefined);
      const codex = provider({
        getAuthState: vi.fn(async () => ({
          authenticated: false, requiresAuth: true, accountType: null,
        })),
        startLogin: vi.fn(async () => ({
          type: "browser" as const, loginId: "timeout-login", url: "https://login",
        })),
        cancelLogin,
      });
      await mount(codex);
      await act(async () => renderer!.root.findAllByProps({ className: "hyo-codex-login" })[0]!.props.onClick());
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1_000); });
      expect(cancelLogin).toHaveBeenCalledWith("timeout-login");
      expect(renderer!.root.findByProps({ className: "hyo-codex-login-retry" }))
        .toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never cancels a login after polling reports success", async () => {
    vi.useFakeTimers();
    try {
      const cancelLogin = vi.fn(async () => undefined);
      const getAuthState = vi.fn()
        .mockResolvedValueOnce({ authenticated: false, requiresAuth: true, accountType: null })
        .mockResolvedValue({ authenticated: true, requiresAuth: true, accountType: "chatgpt" });
      const codex = provider({
        getAuthState,
        startLogin: vi.fn(async () => ({
          type: "browser" as const, loginId: "success-login", url: "https://login",
        })),
        cancelLogin,
      });
      await mount(codex);
      await act(async () => renderer!.root.findAllByProps({ className: "hyo-codex-login" })[0]!.props.onClick());
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      act(() => renderer!.unmount());
      renderer = undefined;
      expect(cancelLogin).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
