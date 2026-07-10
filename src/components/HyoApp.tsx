import React, { useState, useEffect, useMemo } from "react";
import type { App } from "obsidian";
import type HyoPlugin from "../main";
import { ChatPanel } from "./ChatPanel";
import { useSessionManager } from "../hooks/useSessionManager";
import { createClaudeProvider } from "../providers/claude/provider";
import { createCodexProvider } from "../providers/codex/provider";
import { detectProviderCli, getProviderOnboarding } from "../provider-onboarding";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

interface HyoAppProps {
  app: App;
  plugin: HyoPlugin;
}

function resolveProviderCli(
  providerId: "claude" | "codex",
  configuredPath: string,
): string {
  return detectProviderCli({
    providerId,
    configuredPath,
    platform: process.platform,
    home: os.homedir(),
    appData: process.env.APPDATA || "",
    exists: fs.existsSync,
    findOnPath: (binary) => {
      try {
        return execFileSync(process.platform === "win32" ? "where" : "which", [binary], {
          encoding: "utf8",
          timeout: 3000,
        }).trim().split(/\r?\n/)[0] || "";
      } catch {
        return "";
      }
    },
  });
}

export function HyoApp({ app, plugin }: HyoAppProps) {
  const [cliFound, setCliFound] = useState<boolean | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const vaultPath = (app.vault.adapter as any).basePath as string;

  useEffect(() => {
    const handler = () => setSettingsVersion((v) => v + 1);
    window.addEventListener("hyo-settings-changed", handler);
    return () => window.removeEventListener("hyo-settings-changed", handler);
  }, []);

  // Use custom working directory if set, otherwise use vault path
  const workingDirectory = plugin.settings.workingDirectory
    ? plugin.settings.workingDirectory.replace(
        /^~/,
        process.env.HOME || process.env.USERPROFILE || ""
      )
    : vaultPath;

  const resolvedClaudeCli = useMemo(
    () => resolveProviderCli("claude", plugin.settings.providerSettings.claude.cliPath),
    [plugin.settings.providerSettings.claude.cliPath, settingsVersion],
  );
  const resolvedCodexCli = useMemo(
    () => resolveProviderCli("codex", plugin.settings.providerSettings.codex.cliPath),
    [plugin.settings.providerSettings.codex.cliPath, settingsVersion],
  );

  const claudeProvider = useMemo(
    () => createClaudeProvider({
      cliPath: resolvedClaudeCli || plugin.settings.providerSettings.claude.cliPath,
    }),
    [plugin.settings.providerSettings.claude.cliPath, resolvedClaudeCli],
  );
  const codexProvider = useMemo(
    () => createCodexProvider({
      appVersion: plugin.manifest.version,
      command: resolvedCodexCli || plugin.settings.providerSettings.codex.cliPath,
    }),
    [plugin.manifest.version, plugin.settings.providerSettings.codex.cliPath, resolvedCodexCli],
  );
  const providers = useMemo(
    () => [claudeProvider, codexProvider],
    [claudeProvider, codexProvider],
  );
  const providerDefaults = useMemo(
    () => ({
      claude: { model: plugin.settings.providerSettings.claude.model },
      codex: {
        model: plugin.settings.providerSettings.codex.model,
        reasoningEffort: plugin.settings.providerSettings.codex.reasoningEffort || undefined,
        approvalPolicy: plugin.settings.providerSettings.codex.approvalPolicy,
        sandboxMode: plugin.settings.providerSettings.codex.sandboxMode,
        networkAccess: plugin.settings.providerSettings.codex.networkAccess,
      },
    }),
    [
      plugin.settings.providerSettings.claude.model,
      plugin.settings.providerSettings.codex.model,
      plugin.settings.providerSettings.codex.reasoningEffort,
      plugin.settings.providerSettings.codex.approvalPolicy,
      plugin.settings.providerSettings.codex.sandboxMode,
      plugin.settings.providerSettings.codex.networkAccess,
    ],
  );

  const sessionManager = useSessionManager({
    cliPath: resolvedClaudeCli || plugin.settings.providerSettings.claude.cliPath,
    cwd: workingDirectory,
    model: plugin.settings.providerSettings.claude.model,
    permissionMode: plugin.settings.providerSettings.claude.permissionMode,
    defaultAgent: plugin.settings.providerSettings.claude.defaultAgent || "",
    maxOutputTokens: plugin.settings.providerSettings.claude.maxOutputTokens,
    autoGenerateTitles: plugin.settings.autoGenerateTitles,
    settingsVersion,
    providers,
    defaultProviderId: plugin.settings.defaultProvider,
    providerDefaults,
  });

  const activeProviderId = sessionManager.activeProviderId;
  const activeCliPath = activeProviderId === "codex"
    ? resolvedCodexCli
    : resolvedClaudeCli;

  useEffect(() => {
    setCliFound(Boolean(activeCliPath));
  }, [activeCliPath, activeProviderId, settingsVersion]);

  if (cliFound === null) {
    return (
      <div className="hyo-app">
        <div className="hyo-loading">Loading...</div>
      </div>
    );
  }

  if (!cliFound) {
    const platform = process.platform;
    const isWindows = platform === "win32";
    const onboarding = getProviderOnboarding(activeProviderId, platform);
    const { installCommand, terminalName, openInstructions, pasteInstructions } = onboarding;

    const claudeDesktopPrompt = `I need you to install ${onboarding.providerName} CLI on my machine. Here's what to do:

1. Check if it's already installed by running: ${isWindows ? `where ${activeProviderId}` : `which ${activeProviderId}`}
2. If not found, install it by running: ${installCommand}
3. After install, verify it works by running: ${isWindows ? `where ${activeProviderId}` : `which ${activeProviderId}`}
4. Then run: ${activeProviderId}
   My browser will open to log in — that's expected. Once I've logged in, tell me to come back to Obsidian and reopen the Hyo panel.

Be friendly and walk me through each step. I might not be technical.`;

    return (
      <div className="hyo-app">
        <div className="hyo-onboarding">
          <h3>Welcome to Hyo</h3>
          <p className="hyo-onboarding-intro">
            Hyo needs {onboarding.providerName} CLI installed to work. This is a one-time setup
            that takes about 2 minutes.
          </p>
          <p className="hyo-onboarding-intro">
            <a href="https://www.loom.com/share/9fecabcdda3c4e83bae142d67838c2fa" target="_blank" rel="noopener">
              Watch the install guide →
            </a>
            {" · "}
            <a href="https://www.loom.com/share/349eaac59e514142bc47b10469287db0" target="_blank" rel="noopener">
              Watch the user guide →
            </a>
          </p>

          {activeProviderId === "claude" && <div className="hyo-onboarding-option-quick">
            <strong>Quickest way: Let Claude do it</strong>
            <p className="hyo-step-instruction">
              Open the Claude desktop app, switch to the Code tab, and paste
              this prompt. Claude will handle the installation for you.
            </p>
            <button
              className="hyo-copy-prompt-button"
              onClick={(e) => {
                navigator.clipboard.writeText(claudeDesktopPrompt);
                const btn = e.currentTarget;
                btn.textContent = "Copied!";
                setTimeout(() => {
                  btn.textContent = "Copy install prompt";
                }, 2000);
              }}
            >
              Copy install prompt
            </button>
            <p className="hyo-step-note">
              Once Claude Code is installed, close and reopen this panel.
            </p>
          </div>}

          <div className="hyo-onboarding-divider">
            <span>or install manually</span>
          </div>

          <div className="hyo-onboarding-steps">
            <div className="hyo-onboarding-step">
              <strong>Step 1: Open {terminalName}</strong>
              <p className="hyo-step-instruction">{openInstructions}</p>
              <p className="hyo-step-note">
                Don't worry — you won't need to use {terminalName} after this
                initial setup.
              </p>
            </div>

            <div className="hyo-onboarding-step">
              <strong>Step 2: Install {onboarding.providerName} CLI</strong>
              <p className="hyo-step-instruction">
                Copy this command by clicking the code box:
              </p>
              <code
                className="hyo-install-command"
                onClick={(e) => {
                  navigator.clipboard.writeText(installCommand);
                  e.currentTarget.classList.add("copied");
                  setTimeout(
                    () => e.currentTarget.classList.remove("copied"),
                    2000
                  );
                }}
                title="Click to copy"
              >
                {installCommand}
              </code>
              <p className="hyo-step-instruction">
                {pasteInstructions}, then press Enter.
              </p>
              <p className="hyo-step-note">
                You'll see text appear — this is normal. The installation takes
                about 30 seconds.
              </p>
            </div>

            <div className="hyo-onboarding-step">
              <strong>Step 3: Start {onboarding.providerName}</strong>
              <p className="hyo-step-instruction">
                When the installation finishes, type <code>{activeProviderId}</code> and
                press Enter.
              </p>
              <p className="hyo-step-note">
                {activeProviderId === "codex"
                  ? "Return to Hyo to log in with ChatGPT in the Codex status controls."
                  : "Your browser will open asking you to log in with your Anthropic account."}
              </p>
            </div>

            <div className="hyo-onboarding-step">
              <strong>Step 4: Reload Hyo</strong>
              <p className="hyo-step-instruction">
                Close and reopen this panel using the Hyo icon in the sidebar.
              </p>
            </div>
          </div>

          <details className="hyo-onboarding-troubleshooting">
            <summary>Troubleshooting</summary>
            <div className="hyo-troubleshooting-content">
              <p>
                <strong>Command not found after installation?</strong>
              </p>
              <p>
                Close {terminalName} completely, then open it again. The{" "}
                <code>{activeProviderId}</code> command will be available in the new window.
              </p>
              <p>
                <strong>{onboarding.providerName} installed in a different location?</strong>
              </p>
              <p>
                Go to Settings → Hyo Plugin and update the CLI path to where
                {onboarding.providerName} CLI is installed on your machine.
              </p>
              <p>
                <strong>Need an account?</strong>
              </p>
              <p>
                Sign in or learn more at{" "}
                <a href={activeProviderId === "codex" ? "https://chatgpt.com" : "https://claude.ai"} target="_blank" rel="noopener">
                  {activeProviderId === "codex" ? "chatgpt.com" : "claude.ai"}
                </a>
                .
              </p>
            </div>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="hyo-app">
      <ChatPanel sessionManager={sessionManager} plugin={plugin} app={app} />
    </div>
  );
}
