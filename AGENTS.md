# Vellum Assistant — Agent Instructions

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `assistant/` — Main backend service (Bun + TypeScript)
- `cli/` — Multi-assistant management CLI (Bun + TypeScript). See `cli/AGENTS.md`.
- `clients/` — Client apps (macOS/iOS/etc). See `clients/AGENTS.md` and platform docs like `clients/macos/CLAUDE.md`.
- `gateway/` — Channel ingress gateway (Bun + TypeScript)
- `scripts/` — Utility scripts
- `skills/` — First-party skill catalog (portable skill packages). See `skills/AGENTS.md`.
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`). Most commands are shared from [`claude-skills`](https://github.com/vellum-ai/claude-skills) via symlinks; repo-local commands (`/update`, `/release`) live in `.claude/skills/<name>/` as local skill directories.

## Conventions

- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Package manager**: Use `bun install` for dependencies, `bun test <file>` for tests (always scope to specific files), `bunx tsc --noEmit` for type-checking.
- **Install dependencies**: `cd assistant && bun install` (each package has its own `bun.lock`).

## Development

```bash
# Install dependencies
cd assistant && bun install

# Type-check
cd assistant && bunx tsc --noEmit

# Run tests (always scope to specific files)
cd assistant && bun test src/path/to/changed.test.ts

# Lint
cd assistant && bun run lint
```

## Testing

The full test suite is large and will hang or timeout if run unscoped. **Never run `bun test` without specifying file paths.**

- After making changes, run only the tests relevant to what you changed:
  `cd assistant && bun test src/path/to/file.test.ts`
- To run tests matching a pattern: `cd assistant && bun test src/path/to/file.test.ts --grep "pattern"`
- Use `bunx tsc --noEmit` for full-project type-checking instead of running all tests.

## Keep the README up to date

Whenever you modify, add, or remove a slash command in `.claude/commands/`, you MUST update `README.md` to reflect the change. The README's "Slash Commands" section should always match the current set of commands. Update the TLDR description if the command's purpose changed, add new entries for new commands, and remove entries for deleted commands.

## Comments

Comments should explain **why** something is done and provide non-obvious context, not describe what the code does. If the code is clear enough to understand on its own, it doesn't need a comment. Reserve comments for surprising behavior, subtle invariants, workarounds, and design rationale.

## Keep the Architecture Diagram up to date

Whenever you introduce, remove, or significantly modify a service, module, or data flow, update the relevant architecture docs (`ARCHITECTURE.md` index and impacted domain docs). Mermaid diagrams must accurately represent current architecture.

## Keep AGENTS.md up to date

When your PR establishes a new mandatory pattern, convention, or architectural constraint that other agents must follow, update `AGENTS.md` in the same PR. Examples: introducing a new abstraction layer that all callsites must use, adding a guard test that enforces an import rule, or changing how a subsystem handles failure modes. If the pattern is only relevant within a single file or module, a code comment is sufficient — only add to `AGENTS.md` when the rule applies project-wide.

## Slash Commands

Most commands are shared from [`claude-skills`](https://github.com/vellum-ai/claude-skills) via symlinks. Repo-local commands (`/update`, `/release`) live in `.claude/skills/<name>/`. See `.claude/README.md` for the full list. The `/update` command uses `vellum ps`, `vellum sleep`, and `vellum wake` to manage assistant and gateway lifecycle.

## Linear Ticket Hygiene

When working on a Linear ticket, include the issue ID in branch names and commit messages for automatic linking. Keep ticket status in sync: move to In Progress when starting, In Review when PR is created, Done when merged. Don't leave tickets stale.

## Track merged PRs

Whenever you merge a PR, you MUST append its URL to `.private/UNREVIEWED_PRS.md` so that `/check-reviews` can pick it up for review triage.

## Implementing new functionality
Before implementing new functionality do a quick check to see if the new feature has already been implemented

## Dead Code Removal

Proactively remove unused code during every change. Remove code your change makes unused, clean up adjacent dead code, delete rather than comment out, check for orphaned files. Ask: "After my change, is there any code that nothing calls, imports, or references?" If yes, delete it.

## Backwards Compatibility

We have no external customers or users yet. Move fast and do not preserve backwards compatibility unless explicitly asked. Specifically:

- **Do not** keep aliased or re-exported symbols for old import paths.
- **Do not** add fallback reads from deprecated data stores or config locations.
- **Do not** maintain old API response shapes, URL patterns, or wire formats alongside new ones.
- **Do not** add migration code, shims, or adapters for old state.

When a change breaks an existing interface, contract, or data format: **flag the break in the PR description** so the reviewer is aware, but proceed with the clean implementation. Only preserve compatibility if the reviewer explicitly requests it.

This policy will change once the project has users. When you encounter existing backwards-compatibility code while working on a file, remove it — the same policy applies to old code as to new code. Until then, every backwards-compat shim is dead weight that slows us down.

## Extensibility Principle

Vellum is a general-purpose assistant. Build new capabilities as reusable, extensible primitives that work across contexts — not narrow solutions for one use case. Ask: "Could someone reuse this in a different context?" If not, generalize.

## Code Review Checklist

When reviewing PRs, flag: special-purpose capabilities (flag for human review, don't reject), duplicate capabilities (suggest reuse), and missing parameterization (hardcoded values that should be configurable).

## Human Attention Comments on PRs

After creating a PR, consider whether it contains anything that genuinely warrants focused human review — architectural decisions, security-sensitive changes, complex logic, critical path changes, deletions, or areas of low confidence. Skip for routine changes.

**How:** `gh pr comment <number> --body "<comment>"`

**Comment format:**

```
## 👀 Where to focus your review

- **<file_path or area>**: <why this needs attention>
- ...

**Risk level:** <Medium | High> — <one-sentence explanation>
```

## Public API / Webhook Ingress

All inbound HTTP endpoints must be routed through the gateway (`gateway/`). See `gateway/AGENTS.md` for full rules including gateway-only API consumption, SKILL.md patterns, and channel identity vocabulary. Guard test: `gateway-only-guard.test.ts`.

## Assistant Identity Boundary

The daemon uses `DAEMON_INTERNAL_ASSISTANT_ID` (`'self'`) from `assistant/src/runtime/assistant-scope.ts` for all internal scoping. External assistant IDs are a gateway/platform edge concern. Do not import `normalizeAssistantId()` in daemon code, and do not add assistant-scoped routes to the daemon HTTP server. Guard test: `assistant-id-boundary-guard.test.ts`.

## Assistant Feature Flags

Feature flags use canonical key format `feature_flags.<flagId>.enabled`. Declare new flags in `meta/feature-flags/feature-flag-registry.json` with `scope: "assistant"`. The resolver in `assistant/src/config/assistant-feature-flags.ts` checks config overrides, then registry defaults, then defaults to enabled. Guard tests enforce format, registry declaration, and canonical keys.

## LLM Provider Abstraction

All LLM calls must go through the provider abstraction — use `getConfiguredProvider()` from `providers/provider-send-message.ts`. Never import `@anthropic-ai/sdk` directly (only `providers/anthropic/client.ts` may). Guard test: `no-direct-anthropic-sdk-imports.test.ts`.

Use `modelIntent` (`'latency-optimized'`, `'quality-optimized'`, `'vision-optimized'`) instead of hardcoded model IDs. Use provider-agnostic language in comments and logs ('LLM' not 'Haiku'/'Sonnet'). Route text generation through the daemon process — direct provider calls discard user context and preferences.

## HTTP API Patterns

See `assistant/src/runtime/AGENTS.md` for HTTP API patterns (message sending, approvals, channel approvals).

## HTTP-First for New Endpoints

New endpoints must be HTTP routes on the runtime server, not IPC-only. See `assistant/src/runtime/AGENTS.md`.

## Error Handling Conventions

See `assistant/docs/error-handling.md` for error handling conventions (throw vs result objects vs null).

## Notification Pipeline

All notification producers must go through `emitNotificationSignal()`. See `assistant/src/notifications/AGENTS.md`.

## Trust & Guardian Invariants

Guardian and trust invariants are enforced in domain-specific code. See `assistant/src/approvals/AGENTS.md` for: approval flow resilience, guardian verification (identity-bound consumption), guardian privilege isolation (tool/history gates for untrusted actors), and memory provenance (untrusted actors excluded from extraction/recall).

## Tooling Direction

Do not add new tool registrations using the `class ____Tool implements Tool` pattern. Prefer skills in `assistant/src/config/bundled-skills/` that teach the model CLI tools. When touching existing tool-based flows, migrate toward skill-driven CLI usage. Keep the system prompt minimal.

## Skill Independence

Skills must be self-contained and portable — no coupling to daemon tools, internals, or repo-specific modules. Use `scripts/` for supporting logic with inline dependencies. No interactive prompts. Relative paths only. Ask: "Could this skill be copied into a different project and still work?"

## Assistant-Driven Judgement

Judgement calls affecting user experience should be made by the assistant through the daemon — not hardcoded heuristics. Reserve deterministic logic for mechanical operations (parsing, validation, access control). If you're writing string matches or scoring functions to approximate what the model would decide, route it through the daemon instead.

## User-Facing Terminology: "daemon" vs "assistant"

"Daemon" is an internal implementation detail. In all user-facing text — CLI output, error messages, help strings, SKILL.md instructions that would be relayed to users, README documentation, and UI strings — use **"assistant"** instead of "daemon". Internal code (variable names, class names, file paths, log messages, comments explaining architecture) may continue using "daemon" since users don't see those. When in doubt, ask: "Would a user ever read this?" If yes, say "assistant".

## Multi-Instance Path Invariant

When the daemon runs with `BASE_DATA_DIR` set to an instance directory (e.g. `~/.vellum/instances/alice/`), `getRootDir()` resolves to `join(BASE_DATA_DIR, ".vellum")`. All CLI and daemon code that references instance-scoped files must use `join(instanceDir, ".vellum", ...)` — never assume the root is `~/.vellum/` directly. This ensures socket paths, PID files, tokens, and config are correctly scoped per instance.

## Qdrant Port Override

Use `QDRANT_HTTP_PORT` (not `QDRANT_URL`) when allocating per-instance Qdrant ports. Setting `QDRANT_URL` triggers QdrantManager's external/remote mode which bypasses the local managed Qdrant lifecycle (download, start, health checks). The CLI deletes `QDRANT_URL` from the environment when spawning instance daemons to ensure local Qdrant management is used.

## Memory Conflict Handling — Internal Only

Memory conflicts must never surface as user-facing clarification prompts. The conflict gate evaluates and resolves conflicts internally without producing any user-visible output — no injected instructions, no clarification questions, no blocking the user's request. The response path always continues answering the user. If you add or modify conflict-related code, verify that `ConflictGate.evaluate()` returns `void` (not a user-facing string), that no conflict text is emitted into the agent loop's message stream, and that `session-runtime-assembly.ts` does not inject conflict instructions. Guard tests: `session-conflict-gate.test.ts`, `session-agent-loop.test.ts`, `memory-lifecycle-e2e.test.ts`.

## Release Update Hygiene

When shipping a release with user/assistant-facing changes, update `assistant/src/config/templates/UPDATES.md`. Leave empty for no-op releases. Don't modify `~/.vellum/workspace/UPDATES.md` directly. Checkpoint keys (`updates:active_releases`, `updates:completed_releases`) in `memory_checkpoints` track bulletin lifecycle — don't manipulate directly.
