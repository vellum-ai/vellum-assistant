---
name: testing-web-state-management
description: Test state management refactors in apps/web (e.g. useReducer → Zustand, context → store). Use when verifying hook/store changes that don't alter UI behavior.
---

# Testing Web App State Management Refactors

Use this skill when testing PRs that refactor internal state management in `apps/web/` — e.g. converting `useReducer` to Zustand stores, replacing context providers with stores, or restructuring hook interfaces.

## When This Applies

- Changes to files in `apps/web/src/domains/chat/lib/` (state files, reducers)
- Changes to hook interfaces in `apps/web/src/domains/chat/hooks/`
- Adding/removing state management dependencies (zustand, jotai, etc.)
- No visible UI changes — same actions, same state transitions, same rendering

## Environment Setup

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd apps/web
bun install
```

## Test Procedure

These refactors are purely internal plumbing. UI testing would look identical whether the change works or is broken. Use shell-based verification:

### 1. Unit Tests
```bash
cd apps/web && bun test src/domains/chat/lib/conversation-list-state.test.ts
```
- All existing reducer tests must pass (proves logic preserved)
- New store tests should cover: initialization, dispatch transitions, reference stability

### 2. Type Safety
```bash
cd apps/web && bunx tsc --noEmit 2>&1 | grep -E "^src/domains/chat/(hooks|lib/)"
```
- Zero new type errors in changed files
- Pre-existing errors (e.g. `use-assistant-lifecycle.ts` null assignability, missing `@/generated/` modules) are expected and unrelated

### 3. Lint
```bash
cd apps/web && bun run lint
```
- Exit code 0, no errors
- Catches unused imports (stale `Dispatch<Action>` types)

### 4. Prop-Threading Audit
```bash
grep -rn "<old_prop_name>" apps/web/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".test." | grep -iE "(interface |type .*=|Dispatch<)"
```
- Verify no remaining interface/type definitions reference the removed prop
- Internal usage within hook bodies (assigned from store) is expected and correct
- Stream handler context (`StreamHandlerContext`) may intentionally preserve the prop for non-React handler functions

### 5. Dependency Pinning
```bash
grep <package_name> apps/web/package.json
```
- Must show exact version (no `^` or `~` prefix) per AGENTS.md

## Known Limitations

- Tests depending on `@/generated/api/client.gen.js` fail with module-not-found — this is pre-existing (generated code is gitignored in the open-source repo)
- No local app testing available without `vel up web` setup and platform repo — these refactors don't need it since behavior is identical
- UI/E2E testing adds no value for pure state management changes — a browser recording would look the same whether the change works or not

## No Recording Needed

Do NOT record browser interactions for these changes. Shell command output is the evidence. Include test output in the PR comment and test report.
