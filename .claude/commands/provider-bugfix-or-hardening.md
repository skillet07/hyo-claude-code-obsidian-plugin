---
name: provider-bugfix-or-hardening
description: Workflow command scaffold for provider-bugfix-or-hardening in hyo-claude-code-obsidian-plugin.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /provider-bugfix-or-hardening

Use this workflow when working on **provider-bugfix-or-hardening** in `hyo-claude-code-obsidian-plugin`.

## Goal

Fixes bugs or hardens the logic in provider implementations, especially around lifecycle, event routing, and session management.

## Common Files

- `src/providers/codex/provider.ts`
- `src/providers/codex/provider.test.ts`
- `src/providers/codex/event-normalizer.ts`
- `src/providers/codex/event-normalizer.test.ts`
- `src/providers/codex/notification-router.ts`
- `src/providers/codex/notification-router.test.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit src/providers/{provider}/*.ts and corresponding *.test.ts files
- Edit src/hooks/useSessionManager.ts and/or src/hooks/useSessionManager.integration.test.ts
- Potentially update src/components/ChatPanel.tsx or related UI files if the bug affects user interaction
- Update src/providers/types.ts if type changes are needed

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.