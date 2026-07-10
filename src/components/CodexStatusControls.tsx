import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ChatProvider,
  ProviderApprovalPolicy,
  ProviderAuthState,
  ProviderLoginStartResult,
  ProviderModelInfo,
  ProviderRateLimits,
  ProviderSandboxMode,
  ProviderSessionOptions,
} from "../providers/types";

interface CodexStatusControlsProps {
  provider: ChatProvider;
  options: ProviderSessionOptions;
  onModelChange(model: string): void;
  onReasoningEffortChange(effort?: string): void;
  onApprovalPolicyChange(policy: ProviderApprovalPolicy): void;
  onSandboxModeChange(mode: ProviderSandboxMode): void;
  onNetworkAccessChange(enabled: boolean): void;
}

export function CodexStatusControls({
  provider,
  options,
  onModelChange,
  onReasoningEffortChange,
  onApprovalPolicyChange,
  onSandboxModeChange,
  onNetworkAccessChange,
}: CodexStatusControlsProps) {
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [auth, setAuth] = useState<ProviderAuthState | null>(null);
  const [rateLimits, setRateLimits] = useState<ProviderRateLimits | null>(null);
  const [login, setLogin] = useState<ProviderLoginStartResult | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    const [modelsResult, authResult, rateLimitsResult] = await Promise.allSettled([
      provider.listModels?.() ?? Promise.resolve([]),
      provider.getAuthState?.() ?? Promise.resolve(null),
      provider.getRateLimits?.() ?? Promise.resolve(null),
    ]);
    if (modelsResult.status === "fulfilled") setModels(modelsResult.value);
    if (authResult.status === "fulfilled") setAuth(authResult.value);
    if (rateLimitsResult.status === "fulfilled") setRateLimits(rateLimitsResult.value);
    const failure = [authResult, modelsResult, rateLimitsResult]
      .find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      setError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
    }
  }, [provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!login || login.type === "complete" || !provider.getAuthState) return;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void provider.getAuthState!(true).then((nextAuth) => {
        setAuth(nextAuth);
        if (nextAuth.authenticated) {
          clearInterval(timer);
          setLogin(null);
          void refresh();
        }
      }).catch(() => undefined).finally(() => {
        checking = false;
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [login, provider, refresh]);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === options.model) ??
      models.find((model) => model.isDefault) ?? models[0],
    [models, options.model],
  );

  const startLogin = async (method: "browser" | "device") => {
    if (!provider.startLogin) return;
    try {
      setError("");
      const result = await provider.startLogin(method);
      setLogin(result);
      if (result.type === "browser") {
        globalThis.open?.(result.url, "_blank", "noopener");
      } else if (result.type === "device") {
        globalThis.open?.(result.url, "_blank", "noopener");
      } else {
        await refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const changeSandbox = (mode: ProviderSandboxMode) => {
    if (
      mode === "danger-full-access" &&
      !(globalThis.confirm?.(
        "Danger: full access lets Codex read, write, and execute outside the workspace without sandbox protection. Enable it?",
      ) ?? false)
    ) return;
    onSandboxModeChange(mode);
  };

  const usage = rateLimits?.default.primary;

  return (
    <div className="hyo-codex-controls">
      {auth && !auth.authenticated && auth.requiresAuth && (
        <span className="hyo-codex-auth">
          <button className="hyo-codex-login" onClick={() => void startLogin("browser")}>
            Log in with ChatGPT
          </button>
          <button className="hyo-codex-login" onClick={() => void startLogin("device")}>
            Use device code
          </button>
          {login?.type === "device" && (
            <span className="hyo-codex-device-code">Code: {login.userCode}</span>
          )}
        </span>
      )}
      {usage && <span className="hyo-codex-usage">{Math.round(usage.usedPercent)}% used</span>}
      <select
        aria-label="Codex model"
        className="hyo-codex-select"
        value={options.model}
        onChange={(event) => onModelChange(event.target.value)}
      >
        <option value="">Server default</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>{model.displayName}</option>
        ))}
      </select>
      <select
        aria-label="Codex reasoning effort"
        className="hyo-codex-select"
        value={options.reasoningEffort ?? ""}
        onChange={(event) => onReasoningEffortChange(event.target.value || undefined)}
      >
        <option value="">Server default</option>
        {selectedModel?.effortOptions.map((effort) => (
          <option key={effort.id} value={effort.id}>{effort.id}</option>
        ))}
      </select>
      <select
        aria-label="Codex approval policy"
        className="hyo-codex-select"
        value={options.approvalPolicy ?? "on-request"}
        onChange={(event) => onApprovalPolicyChange(event.target.value as ProviderApprovalPolicy)}
      >
        <option value="untrusted">Untrusted</option>
        <option value="on-request">On request</option>
        <option value="never">Never ask</option>
      </select>
      <select
        aria-label="Codex sandbox mode"
        className="hyo-codex-select"
        value={options.sandboxMode ?? "workspace-write"}
        onChange={(event) => changeSandbox(event.target.value as ProviderSandboxMode)}
      >
        <option value="read-only">Read only</option>
        <option value="workspace-write">Workspace write</option>
        <option value="danger-full-access">Danger: full access</option>
      </select>
      <label className="hyo-codex-network">
        <input
          aria-label="Codex network access"
          type="checkbox"
          checked={options.networkAccess ?? false}
          onChange={(event) => onNetworkAccessChange(event.target.checked)}
        />
        Network
      </label>
      {error && <span className="hyo-codex-error" title={error}>Codex unavailable</span>}
    </div>
  );
}
