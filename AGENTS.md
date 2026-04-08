# Vellum Assistant — Agent Instructions

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `assistant/` — Main backend service (Bun + TypeScript)
- `cli/` — Multi-assistant management CLI (Bun + TypeScript). See `cli/AGENTS.md`.
- `clients/` — Client apps (macOS/iOS/etc). See `clients/AGENTS.md` and platform docs like `clients/macos/AGENTS.md`.
- `gateway/` — Channel ingress gateway (Bun + TypeScript)
- `packages/` — Shared internal packages (e.g. `ces-contracts` for CES wire-protocol schemas)
- `scripts/` — Utility scripts
- `skills/` — First-party skill catalog (portable skill packages). See `skills/AGENTS.md` for contribution rules and portability requirements.
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`). Most commands are shared from [`claude-skills`](https://github.com/vellum-ai/claude-skills) via symlinks; repo-local commands (`/update`, `/release`) live in `.claude/skills/<name>/` as local skill directories. The `/update` command uses `vellum ps`, `vellum sleep`, and `vellum wake` to manage assistant lifecycle.

## Intellectual Honesty

Defend your technical positions. If you change your mind, explain what new information changed it — not just that the user questioned it. Do not flip-flop to agree with the user; sycophantic responses erode trust and lead to worse outcomes.

When making recommendations, consider multiple angles — trade-offs, failure modes, alternative approaches — and arrive at a strong, evidence-backed conclusion before presenting it. Vague or hedged suggestions waste time; a clear recommendation with explicit reasoning is always more useful, even if the user ultimately disagrees.

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

## Dependencies

This project is licensed under MIT. All dependencies must have MIT-compatible licenses (MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, Unlicense, or similar permissive licenses). Do not add dependencies with copyleft licenses (GPL, AGPL, LGPL, SSPL, EUPL) or proprietary/restrictive licenses without explicit approval.

When adding a new dependency:
1. Check its license in the package's `package.json` or LICENSE file.
2. Dual-licensed packages (e.g. "MIT OR GPL-3.0") are acceptable — we use them under the MIT-compatible option.
3. If unsure about compatibility, flag it in the PR for review.

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
  - **Single-PR workflows** (`/do`, `/work`, standalone PRs):
    - **Commit message**: Include `Closes JARVIS-123` (or `Fixes`, `Resolves`) in the commit body so Linear auto-closes the issue when the PR merges.
    - **PR description**: Mention `Closes JARVIS-123` in the PR body for redundancy.
  - **Multi-PR plans** (`/run-plan`, `/blitz`, `/safe-blitz`):
    - **Intermediate PRs**: Use `Part of JARVIS-123` in commit messages and PR bodies. This links the PR to the issue without triggering Linear's auto-close automation.
    - **Final PR only**: Use `Closes JARVIS-123` to trigger the auto-close.
  - **Status sync**: Set In Progress when starting work. For single-PR workflows, move to In Review when the PR is opened. For multi-PR plans, do not toggle status between PRs — let the final PR's `Closes` keyword handle the Done transition.
- **Track merged PRs**: Append PR URL to `.private/UNREVIEWED_PRS.md` so `/check-reviews` can triage.
- **Human attention comments**: After creating a PR with non-routine changes (architectural decisions, security, complex logic, deletions, low confidence), leave a `gh pr comment` highlighting where to focus review and the risk level. Skip for routine changes.

## Keep Docs Up to Date

- **Internal reference**: When modifying slash commands in `.claude/commands/`, update the "Claude Code Workflow" section in `docs/internal-reference.md` to match.
- **Architecture**: When introducing, removing, or significantly modifying a service/module/data flow, update `ARCHITECTURE.md` and impacted domain docs. Mermaid diagrams must reflect current architecture.
- **AGENTS.md**: When a PR establishes a new mandatory pattern or architectural constraint, update `AGENTS.md`. Only for project-wide rules — use code comments for module-scoped patterns.

## Worktrees & Source Control

Never commit worktree directories or worktree artifacts to the repository. Git worktrees (created by `git worktree add`, Codex, or similar tools) are local working copies and must remain local. The `.gitignore` already excludes common worktree directory patterns (`worktrees/`, `.worktrees/`, `.codex-worktrees/`, `*-worktrees/`), but be vigilant about new naming conventions. If a tool creates worktree directories under a new prefix, add the pattern to `.gitignore` before committing.

**References:**
- [Git Worktree documentation](https://git-scm.com/docs/git-worktree) — worktrees are meant to be local, ephemeral working directories
- [gitignore documentation](https://git-scm.com/docs/gitignore) — patterns for excluding generated/local files

## Dead Code Removal

Proactively remove unused code during every change. Remove code your change makes unused, clean up adjacent dead code, delete rather than comment out, check for orphaned files. Ask: "After my change, is there any code that nothing calls, imports, or references?" If yes, delete it.

## Backwards Compatibility

We have real users — maintain backwards compatibility for all interfaces, persisted state, and data. Never ship a change that silently breaks existing behavior. When a change alters workspace file paths, directory structure, data shapes, namespaces, column schemas, or storage formats, include a migration in the same PR.

**Which migration strategy to use:**

| What changed | Migration type | Location |
|---|---|---|
| Workspace files (renames, moves, format changes under `~/.vellum/workspace/`) | Workspace migration | `assistant/src/workspace/migrations/` — append to `WORKSPACE_MIGRATIONS` in `registry.ts` |
| Database schema or data (columns, indexes, backfills) | DB migration | `assistant/src/memory/migrations/` — add function and register in `db-init.ts` |

Migrations must be **idempotent** (safe to re-run if interrupted) and **append-only** (never reorder or remove existing entries). Test migrations — see `assistant/src/__tests__/workspace-migration-*.test.ts` and `assistant/src/__tests__/db-*.test.ts` for patterns. Flag breaking changes in PR descriptions. If a migration is infeasible, call it out explicitly for human review.

## Assistant-Driven Judgement

Judgement calls affecting user experience should be made by the assistant through the daemon — not hardcoded heuristics. Reserve deterministic logic for mechanical operations (parsing, validation, access control). If you're writing string matches or scoring functions to approximate what the model would decide, route it through the daemon instead.

## Public API / Webhook Ingress

All inbound HTTP endpoints must be routed through the gateway (`gateway/`). See `gateway/AGENTS.md` for full rules including gateway-only API consumption, SKILL.md patterns, and channel identity vocabulary. Guard test: `gateway-only-guard.test.ts`.

## Assistant Identity Boundary

The daemon uses `DAEMON_INTERNAL_ASSISTANT_ID` (`'self'`) from `assistant/src/runtime/assistant-scope.ts` for all internal scoping. External assistant IDs are a gateway/platform edge concern. Do not import `normalizeAssistantId()` in daemon code, and do not add assistant-scoped routes to the daemon HTTP server. Guard test: `assistant-id-boundary-guard.test.ts`.

## Assistant Feature Flags

Feature flags use simple kebab-case keys (e.g., `browser`, `ces-tools`). Declare new flags in `meta/feature-flags/feature-flag-registry.json` with `scope: "assistant"`. The resolver in `assistant/src/config/assistant-feature-flags.ts` checks config overrides, then registry defaults, then defaults to enabled. Guard tests enforce format, registry declaration, and canonical keys.

## LLM Provider Abstraction

All LLM calls must go through the provider abstraction — use `getConfiguredProvider()` from `providers/provider-send-message.ts`. Never import `@anthropic-ai/sdk` directly (only `providers/anthropic/client.ts` may). Guard test: `no-direct-anthropic-sdk-imports.test.ts`.

Use `modelIntent` (`'latency-optimized'`, `'quality-optimized'`, `'vision-optimized'`) instead of hardcoded model IDs. Use provider-agnostic language in comments and logs ('LLM' not 'Haiku'/'Sonnet'). Route text generation through the daemon process — direct provider calls discard user context and preferences.

## Tooling Direction

New non-skill tool registrations are strongly discouraged — prefer skills instead. See `assistant/src/tools/AGENTS.md` for rationale, approved CES exceptions, and alternatives.

## System Prompt Minimalism

Adding content to the system prompt is a **last resort**. The system prompt is the most expensive real estate in every request — every token added increases latency, cost, and crowds out user context. Before adding anything to the system prompt, exhaust these alternatives first:

1. **Skills** — Encode behavior in a SKILL.md that the assistant loads on demand.
2. **Config / feature flags** — Use runtime configuration instead of prompt-level instructions.
3. **Code** — If a behavior can be enforced programmatically, enforce it in code.

Only add to the system prompt when the behavior cannot be achieved any other way. When you must, keep additions minimal and look for existing content to condense or remove to offset the addition.

CES tools are the only approved exception — see `assistant/src/tools/AGENTS.md` for details.

## User-Facing Terminology: "daemon" vs "assistant"

"Daemon" is an internal implementation detail. In all user-facing text — CLI output, error messages, help strings, SKILL.md instructions that would be relayed to users, README documentation, and UI strings — use **"assistant"** instead of "daemon". Internal code (variable names, class names, file paths, log messages, comments explaining architecture) may continue using "daemon" since users don't see those. When in doubt, ask: "Would a user ever read this?" If yes, say "assistant".

## Multi-Instance Path Invariant

The assistant daemon resolves its root directory as `join(homedir(), ".vellum")` via the internal `vellumRoot()` helper. Root-level paths (PID file, platform token, daemon stderr log, protected directory) always resolve under `~/.vellum/`. Remaining root-level files are being migrated to the workspace directory or removed entirely — see the phase plan in the repo for details.

The CLI (`cli/src/lib/local.ts`) still sets `BASE_DATA_DIR` when spawning named local instances. This is a legacy mechanism slated for removal — the CLI should be migrated to pass `VELLUM_WORKSPACE_DIR` (and any future per-instance env vars) instead of `BASE_DATA_DIR`. Until that migration is complete, the CLI constructs instance-scoped paths directly (e.g. `join(instanceDir, ".vellum", ...)`) rather than relying on the daemon's path helpers.

In Docker mode, `VELLUM_WORKSPACE_DIR` overrides the workspace location (e.g. `/workspace`). Code that needs the workspace path must use the resolved workspace directory rather than assuming it lives under `vellumRoot()`. The workspace volume is shared between the assistant and gateway containers.

## Qdrant Port Override

Use `QDRANT_HTTP_PORT` (not `QDRANT_URL`) when allocating per-instance Qdrant ports. Setting `QDRANT_URL` triggers QdrantManager's external/remote mode which bypasses the local managed Qdrant lifecycle (download, start, health checks). The CLI deletes `QDRANT_URL` from the environment when spawning instance daemons to ensure local Qdrant management is used.

## Docker Volume Architecture

Docker instances use four dedicated volumes with strict per-service access boundaries. Each volume is mounted only by the services that need it, enforcing least-privilege at the container level.

| Volume | Mount path | Access | Contents |
|---|---|---|---|
| **Workspace** (`<name>-workspace`) | `/workspace` | Assistant: read-write, Gateway: read-write, CES: read-only | `config.json`, conversations, apps, skills, db, logs |
| **Gateway security** (`<name>-gateway-sec`) | `/gateway-security` | Gateway only | `trust.json`, `actor-token-signing-key`, `guardian-init.lock` |
| **CES security** (`<name>-ces-sec`) | `/ces-security` | CES only | `keys.enc`, `store.key` |
| **Socket** (`<name>-socket`) | `/run/ces-bootstrap` | Assistant + CES | CES bootstrap socket for initial handshake |

The assistant's container root (`/`) stores per-container ephemeral and persistent state: package installs (`~/.bun`), `device.json`, and embed-worker PID files. This replaces the former shared data volume which previously held all state.

**Key invariants:**

- **Trust rules** are owned by the gateway. In Docker mode (`IS_CONTAINERIZED=true`), the assistant reads and writes trust rules via the gateway's HTTP trust API — it has no direct filesystem access to `trust.json`. The gateway reads `trust.json` from `/gateway-security/trust.json`.
- **Credentials** are owned by the CES. In Docker mode, the assistant and gateway access credentials via the CES HTTP API (`CES_CREDENTIAL_URL`). Neither service has direct filesystem access to `keys.enc` or `store.key`.
- The legacy shared data volume (`<name>-data`) is no longer created for new instances. Existing instances are migrated: gateway security files and CES security files are copied from the data volume to their respective security volumes on startup (see `migrateGatewaySecurityFiles()` and `migrateCesSecurityFiles()` in `cli/src/lib/docker.ts`).

## Workspace & Secrets

**Never store secrets, API keys, or sensitive credentials in the workspace directory.**

- **Local mode**: Use the credential store (`assistant credentials`) or the `~/.vellum/protected/` directory for sensitive data.
- **Docker mode**: Sensitive files are isolated on dedicated security volumes that only the owning service can access. Trust rules (`trust.json`, `actor-token-signing-key`) live on the gateway security volume (`/gateway-security`). Credential keys (`keys.enc`, `store.key`) live on the CES security volume (`/ces-security`). The assistant and gateway access credentials via the CES HTTP API (`CES_CREDENTIAL_URL`), and the assistant accesses trust rules via the gateway's trust HTTP API. Neither the assistant nor the gateway has direct filesystem access to the other service's security volume.

## Release Update Hygiene

When shipping a release with user/assistant-facing changes, update `assistant/src/prompts/templates/UPDATES.md`. Leave empty for no-op releases. Don't modify `~/.vellum/workspace/UPDATES.md` directly. Checkpoint keys (`updates:active_releases`, `updates:completed_releases`) in `memory_checkpoints` track bulletin lifecycle — don't manipulate directly.

## Companion Repos

- **[`vellum-assistant-platform`](../vellum-assistant-platform)** — Django backend that manages platform-hosted ("managed") assistants. Handles authentication (WorkOS OIDC), organization management, assistant lifecycle, and runtime proxying. The desktop app authenticates against it and proxies all runtime traffic through it. Stack: Python 3.14, Django, DRF, PostgreSQL, Redis/Valkey. See `../vellum-assistant-platform/AGENTS.md` for development instructions.

When making changes that could affect the cloud platform, review the sibling `../vellum-assistant-platform` repo for compatibility and required follow-up updates. High-risk change areas include:
- HTTP server behavior and API contracts.
- Stored file and directory structure changes (workspace paths, on-disk formats, exports/imports, migrations).
- Dockerfile or container runtime/build changes.

## Sentry & Linear Integration

Error reporting uses Sentry. Two projects exist: one for the daemon/runtime (Node) and one for the macOS app (Swift). DSNs are configured via environment variables (`SENTRY_DSN_ASSISTANT`, `SENTRY_DSN_MACOS`) — see `.env.example`.

**Sentry CLI**: Use the newer `sentry` CLI (not the legacy `sentry-cli`). Install from `https://cli.sentry.dev/install`. Authenticate with `sentry auth login`.

## No New Daemon HTTP Port Consumers

Do not introduce new callers of the daemon's internal HTTP port from CLI commands or other out-of-process code. The daemon HTTP API is an internal surface consumed by the gateway and native clients — CLI commands run **in-process** and must use the service/store layer directly (see `assistant/src/cli/AGENTS.md`).

When you need to publish events to connected clients (e.g. `open_url`, `avatar_updated`) from code running inside the daemon process, import and call the `assistantEventHub` singleton directly rather than adding a new HTTP endpoint. For CLI commands (which run in-process but may not share the daemon's singleton context), use the file-based signal pattern: write a JSON `ServerMessage` to `signals/emit-event` via `getSignalsDir()` — the daemon's `ConfigWatcher` picks it up and publishes via `assistantEventHub`. See `assistant/src/cli/commands/platform/connect.ts` for an example.

## See Also

- **HTTP API patterns & new endpoints**: `assistant/src/runtime/AGENTS.md`
- **Error handling conventions**: `assistant/docs/error-handling.md`
- **Notification pipeline**: `assistant/src/notifications/AGENTS.md`
- **Trust & guardian invariants**: `assistant/src/approvals/AGENTS.md`
