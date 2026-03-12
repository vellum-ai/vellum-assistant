# Vellum Assistant — Agent Instructions

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `assistant/` — Main backend service (Bun + TypeScript)
- `cli/` — Multi-assistant management CLI (Bun + TypeScript). See `cli/AGENTS.md`.
- `clients/` — Client apps (macOS/iOS/etc). See `clients/AGENTS.md` and platform docs like `clients/macos/CLAUDE.md`.
- `gateway/` — Channel ingress gateway (Bun + TypeScript)
- `scripts/` — Utility scripts
- `skills/` — First-party skill catalog (portable skill packages). See `skills/AGENTS.md`.
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`). Most commands are shared from [`claude-skills`](https://github.com/vellum-ai/claude-skills) via symlinks; repo-local commands (`/update`, `/release`) live in `.claude/skills/<name>/` as local skill directories. The `/update` command uses `vellum ps`, `vellum sleep`, and `vellum wake` to manage assistant lifecycle.

## Development

- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Package manager**: Use `bun install` for dependencies (each package has its own `bun.lock`).

```bash
cd assistant && bun install          # Install dependencies
cd assistant && bunx tsc --noEmit    # Type-check
cd assistant && bun test src/path/to/changed.test.ts  # Run tests
cd assistant && bun run lint         # Lint
```

## Testing

The full test suite is large and will hang or timeout if run unscoped. **Never run `bun test` without specifying file paths.**

- After making changes, run only the tests relevant to what you changed:
  `cd assistant && bun test src/path/to/file.test.ts`
- To run tests matching a pattern: `cd assistant && bun test src/path/to/file.test.ts --grep "pattern"`
- Use `bunx tsc --noEmit` for full-project type-checking instead of running all tests.
- **Regression tests for unfixed bugs**: When adding tests that reproduce a bug or document expected behavior before the fix lands, use `test.todo("description", () => {})` so mainline stays green. Never commit normally-failing `test(...)` cases — red CI blocks merges and erodes signal. Convert `test.todo` to `test` when the implementation PR lands.

## PR Workflow

- **Linear tickets**: When a Linear ticket is provided anywhere in context (user message, TODO, plan), use the issue identifier (e.g. `JARVIS-123`) throughout:
  - **Branch name**: Include the identifier, e.g. `do/jarvis-123-fix-stale-approvals`. Linear auto-links branches that contain the issue ID.
  - **Commit message**: Include `Closes JARVIS-123` (or `Fixes`, `Resolves`) in the commit body so Linear auto-closes the issue when the PR merges.
  - **PR description**: Mention the identifier (e.g. `Closes JARVIS-123`) in the PR body for redundancy — Linear also parses PR descriptions.
  - **Status sync**: Transition the ticket to In Progress when starting work, In Review when the PR is created, and Done when merged. Use the Linear MCP tools when available.
- **Track merged PRs**: Append PR URL to `.private/UNREVIEWED_PRS.md` so `/check-reviews` can triage.
- **Human attention comments**: After creating a PR with non-routine changes (architectural decisions, security, complex logic, deletions, low confidence), leave a `gh pr comment` highlighting where to focus review and the risk level. Skip for routine changes.

## Keep Docs Up to Date

- **README**: When modifying slash commands in `.claude/commands/`, update the README's "Slash Commands" section to match.
- **Architecture**: When introducing, removing, or significantly modifying a service/module/data flow, update `ARCHITECTURE.md` and impacted domain docs. Mermaid diagrams must reflect current architecture.
- **AGENTS.md**: When a PR establishes a new mandatory pattern or architectural constraint, update `AGENTS.md`. Only for project-wide rules — use code comments for module-scoped patterns.

## Dead Code Removal

Proactively remove unused code during every change. Remove code your change makes unused, clean up adjacent dead code, delete rather than comment out, check for orphaned files. Ask: "After my change, is there any code that nothing calls, imports, or references?" If yes, delete it.

## Backwards Compatibility

No external customers yet — do not preserve backwards compatibility unless explicitly asked. No aliases, fallback reads, old API shapes, migration shims, or adapters. Flag breaks in PR descriptions but proceed with the clean implementation. Remove existing backwards-compat code when encountered.

## Assistant-Driven Judgement

Judgement calls affecting user experience should be made by the assistant through the daemon — not hardcoded heuristics. Reserve deterministic logic for mechanical operations (parsing, validation, access control). If you're writing string matches or scoring functions to approximate what the model would decide, route it through the daemon instead.

## Public API / Webhook Ingress

All inbound HTTP endpoints must be routed through the gateway (`gateway/`). See `gateway/AGENTS.md` for full rules including gateway-only API consumption, SKILL.md patterns, and channel identity vocabulary. Guard test: `gateway-only-guard.test.ts`.

## Assistant Identity Boundary

The daemon uses `DAEMON_INTERNAL_ASSISTANT_ID` (`'self'`) from `assistant/src/runtime/assistant-scope.ts` for all internal scoping. External assistant IDs are a gateway/platform edge concern. Do not import `normalizeAssistantId()` in daemon code, and do not add assistant-scoped routes to the daemon HTTP server. Guard test: `assistant-id-boundary-guard.test.ts`.

## Assistant Feature Flags

Feature flags use canonical key format `feature_flags.<flagId>.enabled`. Declare new flags in `meta/feature-flags/feature-flag-registry.json` with `scope: "assistant"`. The resolver in `assistant/src/config/assistant-feature-flags.ts` checks config overrides, then registry defaults, then defaults to enabled. Guard tests enforce format, registry declaration, and canonical keys.

## LLM Provider Abstraction

All LLM calls must go through the provider abstraction — use `getConfiguredProvider()` from `providers/provider-send-message.ts`. Never import `@anthropic-ai/sdk` directly (only `providers/anthropic/client.ts` may). Guard test: `no-direct-anthropic-sdk-imports.test.ts`.

Use `modelIntent` (`'latency-optimized'`, `'quality-optimized'`, `'vision-optimized'`) instead of hardcoded model IDs. Use provider-agnostic language in comments and logs ('LLM' not 'Haiku'/'Sonnet'). Route text generation through the daemon process — direct provider calls discard user context and preferences.

## Tooling Direction

Do not add new tool registrations using the `class ____Tool implements Tool` pattern. Prefer skills in `assistant/src/config/bundled-skills/` that teach the model CLI tools. When touching existing tool-based flows, migrate toward skill-driven CLI usage. Keep the system prompt minimal.

## Skill Independence

Skills must be self-contained and portable — no coupling to daemon tools, internals, or repo-specific modules. Use `scripts/` for supporting logic with inline dependencies. No interactive prompts. Relative paths only. Ask: "Could this skill be copied into a different project and still work?"

Follow the [Agent Skills specification](https://agentskills.io/specification) for SKILL.md format, directory structure, and naming conventions.

## User-Facing Terminology: "daemon" vs "assistant"

"Daemon" is an internal implementation detail. In all user-facing text — CLI output, error messages, help strings, SKILL.md instructions that would be relayed to users, README documentation, and UI strings — use **"assistant"** instead of "daemon". Internal code (variable names, class names, file paths, log messages, comments explaining architecture) may continue using "daemon" since users don't see those. When in doubt, ask: "Would a user ever read this?" If yes, say "assistant".

## Multi-Instance Path Invariant

When the daemon runs with `BASE_DATA_DIR` set to an instance directory (e.g. `~/.vellum/instances/alice/`), `getRootDir()` resolves to `join(BASE_DATA_DIR, ".vellum")`. All CLI and daemon code that references instance-scoped files must use `join(instanceDir, ".vellum", ...)` — never assume the root is `~/.vellum/` directly. This ensures PID files, tokens, and config are correctly scoped per instance.

## Qdrant Port Override

Use `QDRANT_HTTP_PORT` (not `QDRANT_URL`) when allocating per-instance Qdrant ports. Setting `QDRANT_URL` triggers QdrantManager's external/remote mode which bypasses the local managed Qdrant lifecycle (download, start, health checks). The CLI deletes `QDRANT_URL` from the environment when spawning instance daemons to ensure local Qdrant management is used.

## Memory Conflict Handling — Internal Only

Memory conflicts must never surface as user-facing clarification prompts. The conflict gate evaluates and resolves conflicts internally without producing any user-visible output — no injected instructions, no clarification questions, no blocking the user's request. The response path always continues answering the user. If you add or modify conflict-related code, verify that `ConflictGate.evaluate()` returns `void` (not a user-facing string), that no conflict text is emitted into the agent loop's message stream, and that `session-runtime-assembly.ts` does not inject conflict instructions. Guard tests: `session-conflict-gate.test.ts`, `session-agent-loop.test.ts`, `memory-lifecycle-e2e.test.ts`.

## Release Update Hygiene

When shipping a release with user/assistant-facing changes, update `assistant/src/prompts/templates/UPDATES.md`. Leave empty for no-op releases. Don't modify `~/.vellum/workspace/UPDATES.md` directly. Checkpoint keys (`updates:active_releases`, `updates:completed_releases`) in `memory_checkpoints` track bulletin lifecycle — don't manipulate directly.

## Companion Repos

- **[`vellum-assistant-platform`](../vellum-assistant-platform)** — Django backend that manages platform-hosted ("managed") assistants. Handles authentication (WorkOS OIDC), organization management, assistant lifecycle, and runtime proxying. The desktop app authenticates against it and proxies all runtime traffic through it. Stack: Python 3.14, Django, DRF, PostgreSQL, Redis/Valkey. See `../vellum-assistant-platform/AGENTS.md` for development instructions.

## See Also

- **HTTP API patterns & new endpoints**: `assistant/src/runtime/AGENTS.md`
- **Error handling conventions**: `assistant/docs/error-handling.md`
- **Notification pipeline**: `assistant/src/notifications/AGENTS.md`
- **Trust & guardian invariants**: `assistant/src/approvals/AGENTS.md`
