import React, { useEffect, useMemo, useRef, useState } from "react";
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

const LOGIN_POLL_INTERVAL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
type PendingLogin = Extract<ProviderLoginStartResult, { loginId: string }>;
interface OwnedLogin {
  provider: ChatProvider;
  generation: number;
  result: PendingLogin;
}

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
  const [loginStarting, setLoginStarting] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [pollAttempt, setPollAttempt] = useState(0);
  const generationRef = useRef(0);
  const modelsGenerationRef = useRef(0);
  const providerRef = useRef(provider);
  const loginRef = useRef<OwnedLogin | null>(null);
  const startingRef = useRef(false);
  const lastLoginMethodRef = useRef<"browser" | "device">("browser");
  const optionsRef = useRef(options);
  const effortCallbackRef = useRef(onReasoningEffortChange);
  optionsRef.current = options;
  effortCallbackRef.current = onReasoningEffortChange;

  const isCurrent = (target: ChatProvider, generation: number) =>
    providerRef.current === target && generationRef.current === generation;

  const reconcileEffort = (catalog: ProviderModelInfo[]) => {
    const current = optionsRef.current;
    if (!current.reasoningEffort) return;
    const knownModel = current.model
      ? catalog.find((model) => model.id === current.model)
      : catalog.find((model) => model.isDefault);
    if (
      knownModel &&
      !knownModel.effortOptions.some((effort) => effort.id === current.reasoningEffort)
    ) {
      effortCallbackRef.current(undefined);
    }
  };

  const refreshProvider = async (target: ChatProvider, generation: number) => {
    const [modelsResult, authResult, rateLimitsResult] = await Promise.allSettled([
      target.listModels?.() ?? Promise.resolve([]),
      target.getAuthState?.() ?? Promise.resolve(null),
      target.getRateLimits?.() ?? Promise.resolve(null),
    ]);
    if (!isCurrent(target, generation)) return;
    if (modelsResult.status === "fulfilled") {
      modelsGenerationRef.current = generation;
      setModels(modelsResult.value);
    }
    if (authResult.status === "fulfilled") setAuth(authResult.value);
    if (rateLimitsResult.status === "fulfilled") setRateLimits(rateLimitsResult.value);
    const failure = [authResult, modelsResult, rateLimitsResult]
      .find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      setError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
    }
  };

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    providerRef.current = provider;
    modelsGenerationRef.current = 0;
    loginRef.current = null;
    startingRef.current = false;
    setModels([]);
    setAuth(null);
    setRateLimits(null);
    setLogin(null);
    setError("");
    setLoginStarting(false);
    setPollFailed(false);
    void refreshProvider(provider, generation);
    return () => {
      if (generationRef.current === generation) generationRef.current++;
      const owned = loginRef.current;
      if (owned?.provider === provider && owned.generation === generation) {
        loginRef.current = null;
        void provider.cancelLogin?.(owned.result.loginId).catch(() => undefined);
      }
      startingRef.current = false;
    };
  }, [provider]);

  useEffect(() => {
    if (modelsGenerationRef.current !== generationRef.current) return;
    reconcileEffort(models);
  }, [models, options.model, options.reasoningEffort]);

  useEffect(() => {
    const owned = loginRef.current;
    if (!owned || pollFailed || !provider.getAuthState) return;
    const { generation } = owned;
    let checking = false;
    let stopped = false;
    const stop = () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(timeout);
    };
    const poll = () => {
      if (checking) return;
      checking = true;
      void provider.getAuthState!(true).then((nextAuth) => {
        if (stopped || !isCurrent(provider, generation) || loginRef.current !== owned) return;
        setAuth(nextAuth);
        if (nextAuth.authenticated) {
          loginRef.current = null;
          stop();
          setLogin(null);
          setPollFailed(false);
          void refreshProvider(provider, generation);
        }
      }).catch((cause) => {
        if (stopped || !isCurrent(provider, generation) || loginRef.current !== owned) return;
        stop();
        setPollFailed(true);
        setError(`Login status check failed: ${cause instanceof Error ? cause.message : String(cause)}. Retry or cancel login.`);
      }).finally(() => {
        checking = false;
      });
    };
    const interval = setInterval(poll, LOGIN_POLL_INTERVAL_MS);
    const timeout = setTimeout(() => {
      if (!isCurrent(provider, generation) || loginRef.current !== owned) return;
      stop();
      loginRef.current = null;
      setLogin(null);
      setPollFailed(true);
      setError("ChatGPT login timed out after 10 minutes. Retry login.");
      void provider.cancelLogin?.(owned.result.loginId).catch(() => undefined);
    }, LOGIN_TIMEOUT_MS);
    return stop;
  }, [login, pollAttempt, pollFailed, provider]);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === options.model) ??
      models.find((model) => model.isDefault) ?? models[0],
    [models, options.model],
  );

  const selectModel = (modelId: string) => {
    const nextModel = models.find((model) => model.id === modelId) ??
      (modelId ? undefined : models.find((model) => model.isDefault));
    if (
      options.reasoningEffort &&
      !nextModel?.effortOptions.some((effort) => effort.id === options.reasoningEffort)
    ) {
      onReasoningEffortChange(undefined);
    }
    onModelChange(modelId);
  };

  const startLogin = async (method: "browser" | "device") => {
    const start = provider.startLogin;
    if (!start || startingRef.current || loginRef.current) return;
    const target = provider;
    const generation = generationRef.current;
    lastLoginMethodRef.current = method;
    startingRef.current = true;
    setLoginStarting(true);
    setPollFailed(false);
    try {
      setError("");
      const result = await start.call(target, method);
      if (!isCurrent(target, generation)) {
        if (result.type !== "complete") {
          void target.cancelLogin?.(result.loginId).catch(() => undefined);
        }
        return;
      }
      setLogin(result);
      if (result.type !== "complete") {
        loginRef.current = { provider: target, generation, result };
      }
      if (result.type === "browser") {
        globalThis.open?.(result.url, "_blank", "noopener");
      } else if (result.type === "device") {
        globalThis.open?.(result.url, "_blank", "noopener");
      } else {
        await refreshProvider(target, generation);
      }
    } catch (cause) {
      if (isCurrent(target, generation)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (isCurrent(target, generation)) {
        startingRef.current = false;
        setLoginStarting(false);
      }
    }
  };

  const cancelLogin = async () => {
    const owned = loginRef.current;
    if (!owned) return;
    loginRef.current = null;
    setLogin(null);
    setPollFailed(false);
    try {
      await owned.provider.cancelLogin?.(owned.result.loginId);
    } catch (cause) {
      if (isCurrent(owned.provider, owned.generation)) {
        setError(`Could not cancel login: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  };

  const retryLogin = () => {
    setError("");
    setPollFailed(false);
    if (loginRef.current) setPollAttempt((attempt) => attempt + 1);
    else void startLogin(lastLoginMethodRef.current);
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
          <button
            className="hyo-codex-login"
            disabled={loginStarting || Boolean(loginRef.current)}
            onClick={() => void startLogin("browser")}
          >
            Log in with ChatGPT
          </button>
          <button
            className="hyo-codex-login"
            disabled={loginStarting || Boolean(loginRef.current)}
            onClick={() => void startLogin("device")}
          >
            Use device code
          </button>
          {login?.type === "device" && (
            <span className="hyo-codex-device-code">Code: {login.userCode}</span>
          )}
          {login && login.type !== "complete" && (
            <button className="hyo-codex-login-cancel" onClick={() => void cancelLogin()}>
              Cancel
            </button>
          )}
          {pollFailed && login && login.type !== "complete" && (
            <button className="hyo-codex-login-retry" onClick={retryLogin}>
              Retry
            </button>
          )}
        </span>
      )}
      {!login && pollFailed && (
        <button className="hyo-codex-login-retry" onClick={retryLogin}>
          Retry ChatGPT login
        </button>
      )}
      {auth?.authenticated && (
        <span className="hyo-codex-account">
          {[auth.accountType, auth.email, auth.plan].filter(Boolean).join(" · ") ||
            "Signed in"}
        </span>
      )}
      {usage && <span className="hyo-codex-usage">{Math.round(usage.usedPercent)}% used</span>}
      <select
        aria-label="Codex model"
        className="hyo-codex-select"
        value={options.model}
        onChange={(event) => selectModel(event.target.value)}
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
