```markdown
# hyo-claude-code-obsidian-plugin Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to develop, extend, and maintain the `hyo-claude-code-obsidian-plugin` codebase. The repository is a TypeScript project using React for UI components, focused on integrating various code providers (like Codex) into Obsidian. It emphasizes modular provider integration, robust session and event management, and a clear, test-driven workflow for adding features, fixing bugs, and preparing releases.

## Coding Conventions

### File Naming

- Use **PascalCase** for component and main logic files.
  - Example: `ChatPanel.tsx`, `ProviderInstallLink.tsx`
- Use **kebab-case** or **lowercase** for scripts and configuration files.
  - Example: `generate-codex-types.mjs`, `manifest.json`

### Import Style

- Use **relative imports** for all modules.

  ```typescript
  import { useSessionManager } from '../hooks/useSessionManager';
  import CodexStatusControls from './CodexStatusControls';
  ```

### Export Style

- Use **named exports** for all modules.

  ```typescript
  // src/providers/codex/provider.ts
  export function createCodexProvider(options: CodexOptions) { ... }
  ```

### Commit Messages

- Use **Conventional Commits** with prefixes like `fix` and `feat`.
  - Example: `fix: handle provider disconnect edge case`
  - Example: `feat: add Codex provider onboarding UI`

## Workflows

### Add or Evolve Provider Integration

**Trigger:** When adding a new provider or majorly updating provider integration  
**Command:** `/add-provider`

1. Add or update files under `src/providers/{provider}/` (e.g. `app-server-client.ts`, `provider.ts`, `event-normalizer.ts`, etc.).
2. Update `src/providers/index.ts` and `src/providers/types.ts` to register the provider.
3. Update or add tests in `src/providers/{provider}/` and `src/hooks/useSessionManager.integration.test.ts`.
4. Update `src/components/ChatPanel.tsx` and/or `src/hooks/useSessionManager.ts` for UI/session integration.
5. Update `scripts/` for type generation or protocol tooling if needed.

**Example: Registering a new provider**
```typescript
// src/providers/index.ts
export { createCodexProvider } from './codex/provider';
// Add new provider export here
```

### Provider Bugfix or Hardening

**Trigger:** When fixing a bug or improving reliability in provider integration  
**Command:** `/fix-provider-bug`

1. Edit `src/providers/{provider}/*.ts` and corresponding `*.test.ts` files.
2. Edit `src/hooks/useSessionManager.ts` and/or `src/hooks/useSessionManager.integration.test.ts`.
3. Update `src/components/ChatPanel.tsx` or related UI files if the bug affects user interaction.
4. Update `src/providers/types.ts` if type changes are needed.

**Example: Fixing an event normalization bug**
```typescript
// src/providers/codex/event-normalizer.ts
export function normalizeEvent(rawEvent: any): NormalizedEvent {
  // Fix: handle missing event type
  if (!rawEvent.type) return { type: 'unknown', payload: rawEvent };
  // ...
}
```

### Provider UI and Settings Expansion

**Trigger:** When adding or improving provider-related UI or settings  
**Command:** `/add-provider-ui`

1. Edit or add `src/components/*StatusControls*.tsx`, `src/components/HyoStatusBar*.tsx`, `src/components/Provider*.tsx`.
2. Edit or add `src/provider-onboarding.ts`, `src/provider-settings.ts`, and their test files.
3. Edit `src/settings.ts` and `styles.css` for settings logic and styling.
4. Update tests for new UI/settings.

**Example: Adding a new status control**
```typescript
// src/components/CodexStatusControls.tsx
import React from 'react';

export function CodexStatusControls({ status }) {
  return <div>Status: {status}</div>;
}
```

### Release Preparation and Changelog Update

**Trigger:** When preparing for a new release  
**Command:** `/release`

1. Update `CHANGELOG.md`, `README.md`, `SETUP.md`.
2. Update `manifest.json`, `package.json`, `package-lock.json`, `versions.json`.
3. Update or add release artifacts (e.g., `hyo-plugin-beta.zip`).
4. Update or add scripts for type checking, smoke testing, or type generation as needed.
5. Update `src/settings.ts` if settings or version info is exposed.

**Example: Updating the changelog**
```markdown
## [1.2.0] - 2024-06-15
### Added
- Codex provider onboarding UI
- Improved event normalization for Codex
```

## Testing Patterns

- Use **vitest** for all tests.
- Test files follow the pattern `*.test.ts` or `*.test.tsx`.
- Place tests next to their implementation files or in the same directory.

**Example:**
```typescript
// src/providers/codex/provider.test.ts
import { createCodexProvider } from './provider';

test('should initialize Codex provider', () => {
  const provider = createCodexProvider({ apiKey: 'test' });
  expect(provider).toBeDefined();
});
```

## Commands

| Command           | Purpose                                                      |
|-------------------|--------------------------------------------------------------|
| /add-provider     | Add or evolve a provider integration                         |
| /fix-provider-bug | Fix bugs or harden provider logic                            |
| /add-provider-ui  | Add or improve provider-related UI and settings              |
| /release          | Prepare for a release and update changelogs/documentation    |
```