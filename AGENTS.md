# Vellum Assistant — Agent Instructions

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `assistant/` — Main backend service (Bun + TypeScript)
- `cli/` — Multi-assistant management CLI (Bun + TypeScript). See `cli/AGENTS.md`.
- `clients/` — Client apps (macOS/iOS/etc). See `clients/AGENTS.md` and platform docs like `clients/macos/AGENTS.md`.
- `gateway/` — Channel ingress gateway (Bun + TypeScript)
- `packages/` — Shared internal packages (e.g. `service-contracts` for CES wire-protocol schemas)
- `scripts/` — Utility scripts
- `skills/` — First-party skill catalog (portable skill packages). See `skills/AGENTS.md` for contribution rules and portability requirements.
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`). Most commands are shared from [`claude-skills`](https://github.com/vellum-ai/claude-skills) via symlinks; repo-local commands (`/update`, `/release`) live in `.claude/skills/<name>/` as local skill directories. The `/update` command uses `vellum ps`, `vellum sleep`, and `vellum wake` to manage assistant lifecycle.

**`meta/` is a parent package, NOT a shared package.** Its purpose is to be the root workspace that all service packages (`gateway/`, `assistant/`, etc.) descend from — it provides workspace-level tooling, CI configuration, and build scripts. It must never contain runtime code, constants, or configuration files that child services import. A gateway or assistant module importing from `../../meta/` is a layering violation. Static config files (e.g. allowlists, registries) that a service consumes at runtime belong in that service's own package directory. Existing `meta/` contents (feature flags, test infra) are either shared build/CI metadata or are being migrated out.

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

**Version pinning**: Always use exact versions in `package.json` — no `^` or `~` prefixes. Use `bun add --exact` (or `bun add -E`) when adding packages. The root `bunfig.toml` sets `[install] exact = true` to enforce this by default (bun walks parent directories, so it applies to all packages). See [Bun docs on `--exact`](https://bun.sh/docs/cli/add#exact).

When adding a new dependency:
1. Check its license in the package's `package.json` or LICENSE file.
2. Dual-licensed packages (e.g. "MIT OR GPL-3.0") are acceptable — we use them under the MIT-compatible option.
3. If unsure about compatibility, flag it in the PR for review.
4. Verify the version in `package.json` is pinned to an exact version (no `^` or `~`).

### GitHub Actions

All `uses:` steps in `.github/workflows/**` and `.github/actions/**` must pin to a 40-character commit SHA with a trailing `# vX.Y.Z` comment (e.g. `actions/checkout@a1b2c3... # v6.0.2`). Never use a bare major tag (`@v6`) or a floating version tag (`@v6.0.2`) on its own — SHAs are immutable while tags can be force-moved, so SHA pinning is the GitHub security-hardening recommendation. To upgrade: look up the new tag's commit SHA with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`, then replace both the SHA and the trailing comment. For actions that don't publish `vX.Y.Z` tags (e.g. `dawidd6/action-download-artifact`, which tags only bare majors), pin to the SHA with a `# vN` trailing comment instead.

### Swift SPM

In `clients/Package.swift` and any future `Package.swift`, use `.package(url: ..., exact: "X.Y.Z")`. Do not use `.package(url: ..., from: "X.Y.Z")` or other range syntax — the `from:` form silently pulls in new minor/patch releases on each `swift package resolve`.

### Docker base images

In every `Dockerfile`, `FROM` lines must pin the base image to both an exact version tag and an `@sha256:` digest (e.g. `FROM debian:trixie-slim@sha256:...`). Rebuild the digest reference when intentionally upgrading. Do NOT pin `apt-get install` package versions inside Dockerfiles — Debian rotates them out of APT quickly; rely on the base-image digest for reproducibility instead.

### Tool versions

Bun and Node are tracked as separate toolchains; each has its own set of files that must stay in sync. When bumping any file in a set, bump all of them in the same PR so the repo never has drifted copies.

- **Bun**: `.tool-versions`, `setup.sh`, all `bun-version:` workflow inputs, and all production `Dockerfile` bun installs must reference the same exact version string.
- **Node**: `.nvmrc` and every workflow `node-version:` input must reference the same exact version string. (`.nvmrc` is Node-only and is intentionally not tied to the Bun version.)

### What we explicitly do not pin

- `apt-get install` package versions inside Dockerfiles (Debian rotates them out).
- `brew install` formulae in `setup.sh` (Homebrew lacks clean exact-version pinning and it's developer-local).
- Xcode point releases beyond the major tag already set via `sudo xcode-select -s`.
- GitHub-hosted runner system libraries.

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

**Exception — migrations**: Database and data migration files must never be deleted, even when the tables or logic they create have moved elsewhere. Migrations run sequentially on existing installs and skipping an entry breaks the chain. When a migration's responsibility has moved (e.g. a table migrated to another database), keep the file in place and add a comment documenting where the logic now lives.

## Generic Examples

Never include personal user data — real names, emails, phone numbers, account IDs, or other identifying details of specific people — anywhere in the codebase. This covers code, tests, fixtures, documentation, comments, commit messages, and AGENTS.md files. Always use generic placeholders:

- **Names**: `Alice`, `Bob`, `user1`, `Example User`
- **Emails**: `user@example.com` (reserved `example.com`/`example.org` domains)
- **Phone numbers**: fictional numbers from the reserved `555-0100`–`555-0199` range
- **IDs**: `user-123`, `org-abc`, `conv-xyz`

This applies even when the data is the author's own — examples get copied by future contributors, and real data propagates through forks, screenshots, and logs.

**Enforcement:** the pre-commit hook runs `scripts/check-generic-examples.ts` against staged changes. The in-repo patterns are shape-based (non-example emails, phones outside `555-01xx`). Contributors who want to block additional project-specific terms on their own machine can drop them into a local config — see `scripts/generic-examples/README.md`. Inline suppression: add `// generic-examples:ignore-next-line — reason: <why>` on the line above.

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

## Cross-Package Import Boundary

`assistant/` must never import from `gateway/` via relative paths (e.g. `../gateway/src/...`), and vice versa. Each package is an independent build unit — the assistant Docker image and CI typecheck job only install assistant dependencies, so any static import into `../gateway/` breaks the build.

When you need shared logic across packages, extract it into a `packages/` shared module (e.g. `packages/gateway-client`). For test helpers that need the other package's runtime behavior, mock the IPC responses directly — do not import the real handler.

## Public API / Webhook Ingress

All inbound HTTP endpoints must be routed through the gateway (`gateway/`). See `gateway/AGENTS.md` for full rules including gateway-only API consumption, SKILL.md patterns, and channel identity vocabulary. Guard test: `gateway-only-guard.test.ts`.

## Assistant Identity Boundary

The daemon uses `DAEMON_INTERNAL_ASSISTANT_ID` (`'self'`) from `assistant/src/runtime/assistant-scope.ts` for all internal scoping. External assistant IDs are a gateway/platform edge concern. Do not import `normalizeAssistantId()` in daemon code, and do not add assistant-scoped routes to the daemon HTTP server. Guard test: `assistant-id-boundary-guard.test.ts`.

## Assistant Feature Flags

Feature flags use simple kebab-case keys (e.g., `browser`, `ces-tools`). Declare new flags in `meta/feature-flags/feature-flag-registry.json` with `scope: "assistant"`. The resolver in `assistant/src/config/assistant-feature-flags.ts` checks config overrides, then registry defaults, then defaults to enabled. Guard tests enforce format, registry declaration, and canonical keys.

**Cross-repo requirement**: When adding a new flag, you must also open a PR in [`vellum-assistant-platform`](../vellum-assistant-platform) to add the flag to the LaunchDarkly Terraform configuration (`terraform/`) so it exists on the platform for remote sync. See `meta/feature-flags/AGENTS.md` for full steps.

**Permission controls v2 rule**: Under `permission-controls-v2`, do not introduce new deterministic approval modes for assistant-owned actions beyond the conversation-scoped host computer access gate. That means no global toggles, no per-tool or per-command approvals, no 10-minute or conversation-wide approval verbs, no wildcard scopes, and no persistent trust-rule UI for v2 flows. If a new v2 path needs consent, prefer model-mediated conversation flow unless it is a true host-computer or identity-boundary enforcement case.

## LLM Provider Abstraction

All LLM calls must go through the provider abstraction — use `getConfiguredProvider(callSite)` from `providers/provider-send-message.ts`. The `callSite: LLMCallSite` argument is required so the resolver can pick the right per-call-site config. Never import `@anthropic-ai/sdk` directly (only `providers/anthropic/client.ts` may). Guard test: `no-direct-anthropic-sdk-imports.test.ts`.

Each LLM call site has a stable identifier (`LLMCallSite` from `assistant/src/config/schemas/llm.ts`). Pick the appropriate call-site ID for the request — the provider layer resolves provider/model/maxTokens/effort/thinking/contextWindow/etc. via `resolveCallSiteConfig` (in `assistant/src/config/llm-resolver.ts`). Non-main-agent call sites deep-merge five layers from highest to lowest precedence: (1) `llm.callSites.<id>` (call-site override), (2) `llm.profiles.<site.profile>` (the call-site's named profile, if any), (3) `llm.profiles.<overrideProfile>` (per-call ad-hoc override passed to the resolver), (4) `llm.profiles.<activeProfile>` (workspace-wide active profile), (5) `llm.default` (required base). `mainAgent` is the exception: the active profile and per-conversation override profile are the user's chat-model selection and therefore override static `llm.callSites.mainAgent` defaults. A missing `site.profile` reference throws because it is statically referenced from config and validated by schema; missing `overrideProfile`/`activeProfile` references silently fall through because `overrideProfile` is a runtime parameter that cannot be schema-validated and `activeProfile` must degrade gracefully if pointed at a deleted profile mid-edit. Use provider-agnostic language in comments and logs ('LLM' not 'Haiku'/'Sonnet'). Route text generation through the daemon process — direct provider calls discard user context and preferences.

## Skill Isolation

The `assistant/` module must not import from `skills/` via relative paths (e.g. `../skills/meet-join/...`), and `skills/` must not import from `assistant/`. Both directions are enforced by `assistant/src/__tests__/skill-boundary-guard.test.ts`.

First-party skills run as separate processes. The daemon ships their source tree alongside its binary (Docker build context whitelisted by the repo-root `.dockerignore`; macOS `.app` Resources/) plus a generated `manifest.json` that lists the skill's tools, routes, and shutdown hooks. At daemon startup, `assistant/src/daemon/meet-host-startup.ts` reads the manifest and installs proxy tools/routes/hooks; on first invocation, `MeetHostSupervisor` spawns the skill via `bun run` and dispatches via the `assistant-skill.sock` IPC socket. The skill speaks to the daemon through the `SkillHost` contract in `@vellumai/skill-host-contracts` — neither side imports the other. See `skills/meet-join/AGENTS.md` for the meet-join-specific shape.

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

## Qdrant Port Override

Use `QDRANT_HTTP_PORT` (not `QDRANT_URL`) when allocating per-instance Qdrant ports. Setting `QDRANT_URL` triggers QdrantManager's external/remote mode which bypasses the local managed Qdrant lifecycle (download, start, health checks). The CLI deletes `QDRANT_URL` from the environment when spawning instance daemons to ensure local Qdrant management is used.

## Docker Volume Architecture

Docker instances use seven dedicated volumes with strict per-service access boundaries. Each volume is mounted only by the services that need it, enforcing least-privilege at the container level.

| Volume | Mount path | Access | Contents |
|---|---|---|---|
| **Workspace** (`<name>-workspace`) | `/workspace` | Assistant: read-write, Gateway: read-write, CES: read-only | `config.json`, conversations, apps, skills, db, logs, `.backups/`, `.backup.key` |
| **Gateway security** (`<name>-gateway-sec`) | `/gateway-security` | Gateway only | Files private to the gateway container |
| **CES security** (`<name>-ces-sec`) | `/ces-security` | CES only | `keys.enc`, `store.key` |
| **Socket** (`<name>-socket`) | `/run/ces-bootstrap` | Assistant + CES | CES bootstrap socket for initial handshake |
| **Gateway IPC** (`<name>-gateway-ipc`) | `/run/gateway-ipc` | Assistant + Gateway | `gateway.sock` — IPC socket for assistant→gateway calls |
| **Assistant IPC** (`<name>-assistant-ipc`) | `/run/assistant-ipc` | Assistant + Gateway | `assistant.sock` — IPC socket for gateway→assistant calls |
| **Inner dockerd data** (`<name>-dockerd-data`) | `/var/lib/docker` | Assistant only | Docker image cache and container state for the inner `dockerd` running inside the assistant container (Docker-in-Docker model for Meet). Persists the pulled meet-bot image across assistant restarts. |

The assistant's container root (`/`) stores per-container ephemeral and persistent state: package installs (`~/.bun`), `device.json`, and embed-worker PID files. This replaces the former shared data volume which previously held all state.

**Key invariants:**

- **Trust rules** are owned by the gateway. In Docker mode (`IS_CONTAINERIZED=true`), the assistant reads and writes trust rules via the gateway's HTTP trust API — it has no direct filesystem access to `trust.json`. The gateway reads `trust.json` from `/gateway-security/trust.json`.
- **Credentials** are owned by the CES. In Docker mode, the assistant and gateway access credentials via the CES HTTP API (`CES_CREDENTIAL_URL`). Neither service has direct filesystem access to `keys.enc` or `store.key`.
- **Meet bots are nested (Docker-in-Docker) in Docker mode.** The assistant container runs its own `dockerd` instance under an init supervisor and spawns meet-bot containers against that inner engine. The assistant container runs with `CAP_SYS_ADMIN` + `CAP_NET_ADMIN` plus `seccomp=unconfined` + `apparmor=unconfined` so the inner dockerd can create network namespaces, mount overlay filesystems, and issue the clone/unshare/pivot_root syscalls the default LSM profiles block. `--privileged` is deliberately avoided — it grants the full host capability set plus access to every host device node, and dropping it shrinks the escape surface from any code running inside the assistant container. In **bare-metal mode** (assistant running directly on the host), Meet bots are **sibling** containers on the host's Docker engine — the daemon connects to the host's Docker API directly. The assistant auto-detects which mode it is in and picks the correct engine.
- The legacy shared data volume (`<name>-data`) is no longer created for new instances. Existing instances are migrated: gateway security files and CES security files are copied from the data volume to their respective security volumes on startup (see `migrateGatewaySecurityFiles()` and `migrateCesSecurityFiles()` in `cli/src/lib/docker.ts`).

**Bare-metal vs Docker-mode bot spawning:**

- **Bare-metal mode** (assistant process runs directly on the user's machine): Meet bots are **sibling containers** launched against the host's Docker Engine. The host's `docker ps` lists every active bot alongside any other containers the user runs. If the assistant process crashes or is killed, orphan bot containers can linger on the host — the meet-bot image's built-in max-meeting-minutes timeout is the safety net that eventually terminates them, and the assistant also cleans up on graceful shutdown.
- **Docker mode (Docker-in-Docker)**: Meet bots are **nested containers** inside the assistant container's own `dockerd`. The *host's* `docker ps` shows only the assistant/gateway/CES containers — meet-bots are invisible at that level and only appear to `docker ps` run inside the assistant container. Bot lifecycle is tied to the assistant: if the assistant container (or the pod it lives in) dies, the inner `dockerd` dies with it and every bot container is torn down automatically, so orphans are impossible.

**Security tradeoff for Docker mode:** The Docker-in-Docker model requires the assistant container to run with `CAP_SYS_ADMIN` + `CAP_NET_ADMIN` plus `--security-opt seccomp=unconfined` + `--security-opt apparmor=unconfined`, so the inner `dockerd` can configure cgroups, overlay mounts, and container networking without the default seccomp profile blocking the clone/unshare/pivot_root syscalls dockerd issues or the default AppArmor profile denying its mount operations. `--privileged` is deliberately avoided — it implies the full host capability set and access to every host device node, and narrowing to these two caps + two security-opts keeps DinD functional while shrinking the escape surface from any code running inside the assistant container. This is acceptable for single-user local deployments. Managed/hosted deployments that run on Kubernetes must configure Pod Security Admission (or an equivalent admission controller) to allow this capability + security-context on the assistant pod, or swap in a different bot spawn model (e.g. a Kubernetes job runner). Managed Meet support is out of scope for the Docker-in-Docker approach — see [`vellum-assistant-platform`](../vellum-assistant-platform).

**Meet bot workspace mounts**: Bot containers receive a host-path bind of `<daemon-workspace>/meets/<id>/out` for recording output. Audio is streamed over TCP rather than a bind-mounted socket — the daemon binds an OS-assigned port on all interfaces (see `AUDIO_INGEST_BIND_HOST` in `skills/meet-join/daemon/audio-ingest.ts`) and the bot dials `host.docker.internal:<DAEMON_AUDIO_PORT>`. In Docker mode (DinD), the `/out` path lives inside the assistant container and is visible to the inner `dockerd` as a regular host path. In bare-metal mode it lives on the user's machine and is bound into sibling bot containers by the host's Docker engine.

**Backup paths in Docker mode**: The backup system stores local snapshots at `VELLUM_BACKUP_DIR` (default: `/workspace/.backups/`) and the encryption key at `VELLUM_BACKUP_KEY_PATH` (default: `/workspace/.backup.key`) on the workspace volume. This means workspace volume destruction loses both data and backups. For stronger isolation, a dedicated backup volume could be added in a future iteration.

## Workspace & Secrets

**Never store secrets, API keys, or sensitive credentials in the workspace directory.**

- **Local mode**: Use the credential store (`assistant credentials`) or `GATEWAY_SECURITY_DIR` (resolved by `getGatewaySecurityDir()` in `gateway/src/paths.ts`) for sensitive data. Do **not** create new secrets in the daemon's `protected/` directory — that directory is being phased out; all new security-sensitive files belong in the gateway security dir or CES.
- **Docker mode**: Sensitive files are isolated on dedicated security volumes that only the owning service can access. Trust rules (`trust.json`, `actor-token-signing-key`), capability-token secrets, and other gateway-owned security material live on the gateway security volume (`/gateway-security`). Credential keys (`keys.enc`, `store.key`) live on the CES security volume (`/ces-security`). The assistant and gateway access credentials via the CES HTTP API (`CES_CREDENTIAL_URL`), and the assistant accesses trust rules via the gateway's trust HTTP API. Neither the assistant nor the gateway has direct filesystem access to the other service's security volume.
- **The daemon must never read from `GATEWAY_SECURITY_DIR`** or any gateway-owned directory. Any data the daemon needs from the gateway (e.g. capability token verification, feature flags, trust rules) must flow through IPC or HTTP APIs.
- **Do not access the user's `~/.vellum` directory from client packages** (`clients/chrome-extension/`, `clients/macos/`). Clients should read configuration from their own package directory or from `GATEWAY_SECURITY_DIR`. Existing `~/.vellum` references in client code are legacy and should be removed.

## Release Update Hygiene

Release notes for user/assistant-facing changes ship via **workspace migrations**. There is no bundled template to edit and no checkpoint state to clear — the notes are just a migration that writes to `<workspace>/UPDATES.md`.

**To ship release notes:**

1. Add a new migration file at `assistant/src/workspace/migrations/0XX-release-notes-<slug>.ts`. Use the next available sequence number (migrations are append-only). Put the release-note text inline as a string literal inside the migration and append it to `UPDATES.md` in the migration's `run()`.
2. Append the new migration's export to `WORKSPACE_MIGRATIONS` in `assistant/src/workspace/migrations/registry.ts`. Never reorder or remove existing entries.
3. Skip the migration entirely for no-op releases — do not add an empty migration.

**Idempotency requires both the runner AND an in-file marker.** The workspace-migration runner is the primary mechanism: `runWorkspaceMigrations()` in `assistant/src/workspace/migrations/runner.ts` records each successfully applied migration's `WorkspaceMigration.id` in `~/.vellum/workspace/data/.workspace-migrations.json` and skips any ID already in the `applied` set. However, the runner alone does not close two narrow duplicate-append windows, so release-notes migrations **must also** embed an in-file marker and short-circuit when it is present:

1. **Crash mid-migration.** The runner marks a migration as `started` before `run()` executes and promotes it to `applied` only after `run()` returns. If the daemon crashes after `UPDATES.md` is appended but before the checkpoint is finalized, the next boot clears the `started` entry and re-runs the migration — producing a duplicate append.
2. **Failed entries stay applied-adjacent.** Failed migrations persist in the checkpoint state and are not retried, but a migration that partially succeeded (appended, then threw) leaves `UPDATES.md` mutated without a guaranteed `applied` record, so subsequent hand-edits or reruns can double-write.

**Required pattern for release-notes migrations:** embed an HTML marker like `<!-- release-note-id:<migration-id> -->` in the appended block, and before appending, read `UPDATES.md` and skip the append if the marker is already present. Do not drop this check on the assumption that the runner makes it redundant — it does not.

**Processing:** After workspace migrations run at daemon startup, `runUpdateBulletinJobIfNeeded()` fires a background-only conversation (`conversationType: "background"`) via `wakeAgentForOpportunity()` to process `UPDATES.md`. The agent reads the file, acts on whatever is relevant, and deletes `UPDATES.md` when done. `rm UPDATES.md` remains auto-allowed so deletion needs no approval. The job short-circuits when the content hash matches the previously processed value (`updates:last_processed_hash`), so running on every startup is safe.

## Companion Repos

- **[`vellum-assistant-platform`](../vellum-assistant-platform)** — Django backend that manages platform-hosted ("managed") assistants. Handles authentication (WorkOS OIDC), organization management, assistant lifecycle, and runtime proxying. The desktop app authenticates against it and proxies all runtime traffic through it. Stack: Python 3.14, Django, DRF, PostgreSQL, Redis/Valkey. See `../vellum-assistant-platform/AGENTS.md` for development instructions.

When making changes that could affect the cloud platform, review the sibling `../vellum-assistant-platform` repo for compatibility and required follow-up updates. High-risk change areas include:
- HTTP server behavior and API contracts.
- Stored file and directory structure changes (workspace paths, on-disk formats, exports/imports, migrations).
- Dockerfile or container runtime/build changes.
- **Feature flags**: Adding a flag to `meta/feature-flags/feature-flag-registry.json` requires a companion PR in `vellum-assistant-platform` to provision the flag in Terraform. See the [Assistant Feature Flags](#assistant-feature-flags) section.

## Build Environment (`VELLUM_ENVIRONMENT`)

The `VELLUM_ENVIRONMENT` environment variable identifies the runtime environment for all clients (macOS, iOS, CLI, Chrome extension). It is embedded into the app bundle's `LSEnvironment` (Info.plist) at build time by each platform's `build.sh`, or injected via `--define` for the Chrome extension bundler.

| Value | Use cases |
|---|---|
| `local` | Always built from local source code. Enable developer-only features (e.g. build container images from local source, verbose logging). |
| `dev` | Artifacts generated from `main`. Connected to the dev platform; skip production guards. |
| `test` | Stub external services, use test fixtures. |
| `staging` | QA against staging platform before production rollout. Default for release branch builds. |
| `production` | Full production behavior, no developer shortcuts. Set explicitly for final production releases. |

**Defaults**: `build.sh` sets the value automatically when `VELLUM_ENVIRONMENT` is unset:
- `test` command => `test`
- `release` / `release-application` => `staging` for `*-staging*` display versions, otherwise `production`
- `run` command => `local` (for local full-stack development, e.g. `vel up`)
- all other local build commands (plain `build`, etc.) => `dev`

CI and developers can always override by exporting `VELLUM_ENVIRONMENT` before invoking the build script — the explicit value takes precedence.

**Reading the value at runtime** (Swift):
```swift
let env = ProcessInfo.processInfo.environment["VELLUM_ENVIRONMENT"] ?? "production"
```

**Guidelines**:
- Use `VELLUM_ENVIRONMENT` for behavior that varies by deployment target (e.g. local image builds, telemetry sampling, API base URLs).
- Do **not** use it as a substitute for feature flags — flags gate features per-user/org, environments gate per-deployment.
- Do **not** check for `DEBUG` / `RELEASE` compiler flags (`#if DEBUG`) when the distinction is really about deployment environment. A debug build pointed at staging is still `staging`, not `local`.

## Sentry & Linear Integration

Error reporting uses Sentry. Two projects exist: one for the daemon/runtime (Node) and one for the macOS app (Swift). DSNs are configured via environment variables (`SENTRY_DSN_ASSISTANT`, `SENTRY_DSN_MACOS`) — see `.env.example`.

**Sentry CLI**: Use the newer `sentry` CLI (not the legacy `sentry-cli`). Install from `https://cli.sentry.dev/install`. Authenticate with `sentry auth login`.

## CLI ↔ Daemon Communication

**The Unix domain socket IPC (`assistant.sock`) is the preferred method
of inter-process communication between CLI commands and the running daemon.**
Both file-based signals (`signals/` directory + `ConfigWatcher`) and the
daemon HTTP port are deprecated for new CLI-to-daemon interactions.

New commands that need to invoke daemon-side state (conversations, wake,
in-memory lookups) should use the `cliIpcCall()` helper from
`assistant/src/ipc/cli-client.ts` and add a new route file in
`assistant/src/ipc/routes/`, then register it in
`assistant/src/ipc/routes/index.ts`. The `AssistantIpcServer` constructor
auto-registers all routes from the index.

The IPC protocol is newline-delimited JSON over the Unix domain socket:
- Request:  `{ "id": string, "method": string, "params"?: object }`
- Response: `{ "id": string, "result"?: unknown, "error"?: string }`

When you need to publish events to connected clients (e.g. `open_url`,
`avatar_updated`) from code running inside the daemon process, import and
call the `assistantEventHub` singleton directly rather than adding a new
HTTP endpoint.

## See Also

- **HTTP API patterns & new endpoints**: `assistant/src/runtime/AGENTS.md`
- **Error handling conventions**: `assistant/docs/error-handling.md`
- **Notification pipeline**: `assistant/src/notifications/AGENTS.md`
- **Trust & guardian invariants**: `assistant/src/approvals/AGENTS.md`
