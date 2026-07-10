# Hyo — setup guide

Hyo lets you choose Claude Code or Codex for each new chat in desktop Obsidian. You only need to install the provider you want to use; installing both makes both available.

## 1. Install Hyo

1. Open Obsidian **Settings → Community plugins → Browse**.
2. Find **BRAT**, install it, and enable it.
3. Open **Settings → BRAT → Add Beta Plugin**.
4. Paste `https://github.com/evielync/hyo-claude-code-obsidian-plugin` and select **Add Plugin**.
5. Open **Settings → Community plugins**, enable **Hyo - Claude Code & Codex for Obsidian**, and restart Obsidian.

Open Hyo with `Cmd+Shift+H` on macOS or `Ctrl+Shift+H` on Windows/Linux. You can also open the command palette and search for “Hyo.”

## 2. Install a provider

### macOS

Open Terminal: press `Cmd+Space`, type `Terminal`, and press Enter.

For Codex, paste:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

For Claude Code, paste:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Close and reopen Obsidian after the installer finishes.

### Linux

Open your normal terminal application.

For Codex, paste:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

For Claude Code, paste:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Close and reopen Obsidian after the installer finishes.

### Windows

Press the Windows key, type `PowerShell`, and open PowerShell.

The official Codex installer places `codex.exe` under `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`; Hyo checks that location as well as the npm command path. Fully quit every Obsidian window and restart Obsidian after installing so the desktop process receives the updated environment.

For Codex, paste this exact official installer command:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

For Claude Code, paste:

```powershell
irm https://claude.ai/install.ps1 | iex
```

Close every Obsidian window and reopen Obsidian after the installer finishes.

Official references: [Codex CLI](https://developers.openai.com/codex/cli/), [Codex app-server](https://developers.openai.com/codex/app-server/), and [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/setup).

## 3. Sign in

### Claude Code

If Claude Code is already signed in, Hyo uses that login. Otherwise open Hyo, select or create a Claude tab, send a message, and follow the Claude Code browser sign-in flow.

### Codex

Hyo first checks the account already managed by the Codex CLI. If it is signed in, there is nothing else to do.

If sign-in is needed, select a Codex tab and use one of the status-bar buttons:

- **Log in with ChatGPT** opens the official browser flow.
- **Use device code** shows a code and URL for signing in on this or another device.

Return to Obsidian after completing the official page. Hyo checks the CLI account state; it does not receive or store your ChatGPT password, Anthropic password, or provider API keys.

Codex must be stable CLI version `0.144.1` or newer. You can check in Terminal or PowerShell with `codex --version`.

## 4. Choose where the provider can work

By default, Hyo uses your vault folder as the working directory. That means the selected provider can see files in the vault subject to its permission/sandbox settings.

If your project lives elsewhere:

1. Open **Settings → Hyo Plugin**.
2. Find **Advanced → Working directory**.
3. Enter the full project-folder path.
4. Reopen the Hyo panel or start a new chat.

For Codex, the initial safe defaults are **On request**, **Workspace write**, and **Network access off**. Use **Read only** when Codex should not edit anything. Avoid **Danger: full access** unless you understand that it removes sandbox protection.

## 5. Choose Claude or Codex

Open **Settings → Hyo Plugin → Default provider** and choose Claude or Codex.

This choice applies to new chats only. It never changes a chat that is already open. Every tab has a fixed Claude or Codex badge; to switch providers, open a new tab after changing the default.

Provider-specific defaults are below the default-provider setting:

- Claude: model, permission mode, default agent, and existing Claude options.
- Codex: model/server default, reasoning effort, approval policy, sandbox, network access, and CLI path.

## Upgrading from a Claude-only Hyo release

Version `0.4.0` migrates the old flat Claude settings into the Claude provider section. Your Claude CLI path, model, permission mode, default agent, working directory, and general Hyo settings are retained. Claude remains the default unless you explicitly choose Codex.

Existing Claude sessions remain available through the Claude history view. Hyo does not convert Claude sessions into Codex threads. New Codex tabs have their own thread history, models, approvals, skills, rate limits, and account status.

## Quick check

1. Open Hyo.
2. Confirm the new tab badge says the provider you expected.
3. Send a simple message such as “Tell me which working directory you are using; do not change any files.”
4. If you installed both providers, change the default, open a new tab, and repeat. The first tab's badge must not change.

## Troubleshooting

### Hyo still says the CLI is missing

Fully restart Obsidian first. If it still fails:

- macOS/Linux: run `which claude` or `which codex`.
- Windows: run `where claude` or `where codex`.
- Copy the returned path into **Settings → Hyo Plugin → Claude Code CLI path** or **Codex CLI path**, or use the Codex **Auto-detect** button.

If the command returns nothing, rerun the relevant official installer above.

### Codex says it is too old

Hyo requires stable Codex CLI `0.144.1+`. Run the official Codex installer again, check `codex --version`, and restart Obsidian. If you intentionally keep several Codex versions, set **Codex CLI path** to the version Hyo should use.

### Login is stuck

Cancel the login in the Codex status bar and try again. Browser login is easiest on the same computer; device-code login is useful when callbacks or browser launching are restricted. Existing CLI authentication is reused when available.

### Hyo or BRAT will not update

1. Open **Settings → BRAT → Check for updates**.
2. Restart Obsidian and check the Hyo manifest/version in Community plugins.
3. If the version is still old, remove Hyo from BRAT, re-add the repository URL, and enable it again.
4. If Obsidian reports a load error, confirm the downloaded release contains `main.js`, `manifest.json`, and `styles.css`, and that the manifest version is `0.4.0`.

The automated project checks do not replace release testing in desktop Obsidian. macOS, Linux, and Windows installation/login/chat flows and the real-account Codex subagent smoke remain release-operator checks until they are explicitly run and recorded.
