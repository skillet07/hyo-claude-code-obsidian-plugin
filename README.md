# Hyo — Claude Code & Codex for Obsidian

Use Claude Code or Codex in a desktop Obsidian chat while keeping the agent in your vault or chosen project directory.

![Hyo in Obsidian](docs/screenshot.png)

Hyo keeps its existing Claude Code workflow and adds Codex as a second provider. Each tab belongs to one provider for its whole lifetime, so streaming events, approvals, history, and settings cannot cross provider boundaries.

> Hyo is desktop-only. The plugin starts local CLI processes and therefore cannot run in Obsidian Mobile.

## Providers

| | Claude Code | Codex |
|---|---|---|
| Local integration | Claude Code streaming CLI | Stable `codex app-server` over stdio JSONL/JSON-RPC |
| Account | Existing Claude Code login | Existing Codex login, or ChatGPT browser/device login in Hyo |
| Existing Hyo features | Tabs, history, usage/context, models, permissions, agents, plan review, attachments, Markdown, voice | Provider-aware tabs, history, live models, reasoning effort, approvals/questions, tools, compact, skills, rate limits, auth, and subagent activity |
| Default safety controls | Claude permission mode | `on-request`, `workspace-write`, network off |
| Minimum CLI | Current supported Claude Code | Codex CLI `0.144.1` or newer |

The default provider is still Claude for existing and new installations. Change it under **Settings → Hyo Plugin → Default provider**. That setting affects new chats only. Existing tabs retain their provider and show an immutable **Claude** or **Codex** badge.

## Requirements

- [Obsidian](https://obsidian.md) desktop, version 1.5.0 or newer
- At least one supported provider CLI and account:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup) with a supported Claude account
  - [Codex CLI](https://developers.openai.com/codex/cli/) `0.144.1+` with a supported ChatGPT/Codex account
- BRAT while Hyo remains a beta plugin

Hyo does not ask for or store Anthropic or OpenAI API keys. It uses the authentication already managed by the provider CLI. The optional ElevenLabs voice setting is separate from provider authentication.

## Install Hyo

1. In Obsidian, install and enable **BRAT** from **Settings → Community plugins → Browse**.
2. Open **Settings → BRAT → Add Beta Plugin** and add:

   ```text
   https://github.com/evielync/hyo-claude-code-obsidian-plugin
   ```

3. Enable **Hyo - Claude Code & Codex for Obsidian** under **Community plugins**.
4. Open Hyo with `Cmd+Shift+H` on macOS or `Ctrl+Shift+H` on Windows/Linux.

The nontechnical, provider-by-provider walkthrough is in [SETUP.md](SETUP.md).

## Install the provider CLIs

### Codex

Official Codex documentation: [CLI](https://developers.openai.com/codex/cli/) and [app-server](https://developers.openai.com/codex/app-server/).

macOS or Linux:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Confirm `codex --version` reports `0.144.1` or newer. If Codex is already logged in, Hyo reuses that account state. Otherwise select a Codex tab and use **Log in with ChatGPT** for browser login or **Use device code** when a browser callback is inconvenient.

### Claude Code

Follow the [official Claude Code setup guide](https://docs.anthropic.com/en/docs/claude-code/setup), or install from a terminal.

macOS or Linux:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://claude.ai/install.ps1 | iex
```

Hyo reuses the Claude Code login and preserves the existing Claude models, permission modes, agents, plan review, session recovery, usage/context displays, and attachments workflow.

## Codex architecture and supported protocol

For Codex tabs, Hyo starts the official stable `codex app-server --listen stdio://` process. It performs the `initialize` / `initialized` handshake, then uses stable `thread/*`, `turn/*`, `item/*`, account, model, skill, and rate-limit methods. Messages are framed as one JSON object per line. Hyo does not opt into experimental APIs and never falls back to `codex exec`.

The provider layer keeps stream state separate from history reads and routes server requests to the runtime that owns the matching thread and turn. Requests that cannot be safely attributed are cancelled instead of being shown in the wrong tab.

Implemented Codex surfaces include:

- streaming assistant text, reasoning summaries/content, plans, warnings, errors, token usage, and compaction boundaries;
- command execution, file changes, MCP and dynamic tools, web search, image view/generation, sleep, and collaboration/subagent tool cards;
- inline command, file-change, and permission approvals, including allow, allow for the session where supported, and deny;
- structured user questions with safe cancellation when a request or runtime retires;
- thread listing, provider-scoped history loading and renaming, and stable turn resume;
- explicit compact, live model catalog and reasoning effort, enabled skills, account rate limits, and ChatGPT account state;
- Codex subagent spawn/send/wait/close activity from the current stable `collabToolCall` shape, including singular receiver/new-thread IDs and agent status, while retaining compatibility with the Codex CLI 0.144.1 `collabAgentToolCall` shape.

## Security defaults

New Codex settings use:

- approval policy: `on-request`;
- sandbox: `workspace-write`;
- sandbox network access: off.

These are defaults, not a guarantee that every tool is harmless. Review approval cards and keep the working directory narrowly scoped. `read-only` is available when no writes should occur.

**Danger:** `danger-full-access` removes Codex sandbox protection. Hyo shows a confirmation before saving it, but enabling it allows the agent to access anything permitted to your desktop user. `never` approval mode and network access also broaden autonomy; enable them only when you understand the effect.

## Working directory and provider switching

The vault root is the default working directory. To use a different project, set **Settings → Hyo Plugin → Advanced → Working directory**.

Changing the default provider does not convert a conversation. It only controls the next new tab. Provider badges are immutable per tab; open a new tab to switch from Claude to Codex or back.

## Troubleshooting

### Hyo says the provider was not found

Restart Obsidian after installing a CLI. If a GUI-launched Obsidian still cannot find it, set the provider's **CLI path** in Hyo settings or use **Auto-detect**. On macOS/Linux, `which claude` or `which codex` shows the path; on Windows, use `where claude` or `where codex`.

### Codex reports an update/version error

Hyo requires stable Codex CLI `0.144.1+`. Re-run the official installer above, verify `codex --version`, fully restart Obsidian, then reopen Hyo. A prerelease older than the stable minimum is not accepted.

### Codex is not logged in

If an existing CLI login is unavailable, select a Codex tab and use the browser or device-code login controls in its status bar. Hyo polls the official account state and supports retry/cancel; it does not collect the credential itself.

### BRAT does not update Hyo

Use **Settings → BRAT → Check for updates**. If that fails, remove and re-add the repository, restart Obsidian, and confirm the manifest says `0.4.0`. See [SETUP.md](SETUP.md) for a longer recovery path.

## Development and release verification

Install dependencies and run the required aggregate gate:

```sh
npm install
npm run verify
```

`verify` runs TypeScript checking, all unit/integration tests, generated Codex binding drift detection, a production build, and `git diff --check`.

Codex wire bindings are generated with the pinned stable Codex CLI `0.144.1`. The runtime accepts `0.144.1+`, but reproducible type generation and drift checks intentionally require the pinned version:

```sh
npm run codex:generate-types
npm run codex:check-types
```

The drift check generates into the operating system temp directory, compares deterministic file paths and bytes with `src/providers/codex/generated`, and removes the temporary output without changing the repository.

### Opt-in real Codex subagent smoke

This smoke uses a real account and can consume quota. It is excluded from `npm test` and `npm run verify`, and refuses to start without an exact opt-in plus a caller-owned fixture:

```sh
mkdir -p /absolute/path/to/hyo-smoke-fixture
printf 'Hyo smoke fixture\n' > /absolute/path/to/hyo-smoke-fixture/note.md
HYO_CODEX_SMOKE=1 \
HYO_CODEX_SMOKE_CWD=/absolute/path/to/hyo-smoke-fixture \
HYO_CODEX_SMOKE_FIXTURE=note.md \
npm run smoke:codex
```

The script uses only stable app-server JSONL/JSON-RPC, a read-only sandbox, `on-request` approvals, network off, a strict timeout, and one bounded read-only subagent request. It fails instead of granting approvals or answering questions, requires spawn evidence plus either a completed wait/close operation or an actual terminal agent status, interrupts an active turn on failure, and terminates app-server. It never invokes `codex exec`.

### Manual release matrix

Before publishing `0.4.0`, a release operator still needs to test the packaged plugin in desktop Obsidian on each platform. These checks are intentionally not claimed as completed by the automated suite.

| Platform | Claude install/login/chat | Codex install/login/chat | Codex approvals/history/subagent smoke | Status |
|---|---|---|---|---|
| macOS | Operator run | Operator run | Operator run | Not yet recorded |
| Linux | Operator run | Operator run | Operator run | Not yet recorded |
| Windows | Operator run | Operator run | Operator run | Not yet recorded |

## Acknowledgements

[Claudian 2.0.30](https://github.com/YishenTu/claudian/releases/tag/2.0.30) was a useful architectural reference for provider registry/state boundaries, stream-versus-history separation, request routing, and early-event buffering. Hyo's implementation was written independently; this is an acknowledgement of design influence, not a claim that Claudian code was copied.

## Built by

[Ev Chapman](https://evchapman.com) — teaching knowledge workers to build in partnership with AI. Part of the [College of Knowledge](https://evchapman.com/cok) community.
