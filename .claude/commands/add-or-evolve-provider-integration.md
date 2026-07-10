---
name: add-or-evolve-provider-integration
description: Workflow command scaffold for add-or-evolve-provider-integration in hyo-claude-code-obsidian-plugin.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-or-evolve-provider-integration

Use this workflow when working on **add-or-evolve-provider-integration** in `hyo-claude-code-obsidian-plugin`.

## Goal

Adds a new provider (e.g. Codex) or evolves provider integration, including protocol, event normalization, and provider registry.

## Common Files

- `src/providers/codex/app-server-client.ts`
- `src/providers/codex/app-server-process.ts`
- `src/providers/codex/provider.ts`
- `src/providers/codex/event-normalizer.ts`
- `src/providers/codex/notification-router.ts`
- `src/providers/codex/server-request-broker.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Add or update files under src/providers/{provider}/ (e.g. app-server-client.ts, provider.ts, event-normalizer.ts, notification-router.ts, server-request-broker.ts, input-converter.ts, history-mapper.ts, generated/...)
- Update src/providers/index.ts and src/providers/types.ts to register the provider
- Update or add tests in src/providers/{provider}/ and src/hooks/useSessionManager.integration.test.ts
- Update src/components/ChatPanel.tsx and/or src/hooks/useSessionManager.ts for UI/session integration
- Update scripts/ for type generation or protocol tooling if needed

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.