# Vellum Assistant — Agent Instructions

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `clients/` — End-user app surfaces: `clients/web/` (Vite + React Router v7 SPA), `clients/ios/` (Capacitor iOS shell that loads the web app in a WKWebView), and `clients/macos/` (Electron desktop shell that wraps `clients/web/`; daemon/gateway lifecycle is owned by the `vellum` CLI, which the app invokes as a subprocess; auto-update via `electron-updater`; CI workflows are `pr-macos.yaml` / `ci-main-macos.yaml`). See [`clients/README.md`](clients/README.md) and [`clients/AGENTS.md`](clients/AGENTS.md).
- `assistant/` — Main backend service (Bun + TypeScript)
- `cli/` — Multi-assistant management CLI (Bun + TypeScript). See `cli/AGENTS.md`.
- `clients/` — Chrome extension client. See `clients/chrome-extension/README.md`.
- `gateway/` — Channel ingress gateway (Bun + TypeScript)
- `packages/` — Shared internal packages (e.g. `service-contracts` for CES wire-protocol schemas)
- `scripts/` — Utility scripts
- `skills/` — First-party skill catalog (portable skill packages). See `skills/AGENTS.md` for contribution rules and portability requirements.
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`). Most commands are shared from [`claude-skills`](https://github.com/vellum-ai/claude-skills) via symlinks; repo-local commands (`/update`, `/release`) live in `.claude/skills/<name>/` as local skill directories. The `/update` command uses `vellum ps`, `vellum sleep`, and `vellum wake` to manage assistant lifecycle.
- Evals have moved to a dedicated repo: [vellum-ai/evals](https://github.com/vellum-ai/evals).

**`meta/` is a parent package, NOT a shared package.** Its purpose is to be the root workspace that all service packages (`gateway/`, `assistant/`, etc.) descend from — it provides workspace-level tooling, CI configuration, and build scripts. It must never contain runtime code, constants, or configuration files that child services import. A gateway or assistant module importing from `../../meta/` is a layering violation. Static config files (e.g. allowlists, registries) that a service consumes at runtime belong in that service's own package directory. Existing `meta/` contents (feature flags, test infra) are either shared build/CI metadata or are being migrated out.

## Intellectual Honesty

Defend technical positions with evidence. Don't flip-flop to placate the user — explain what new information changed your mind, or hold the position. When recommending, consider trade-offs and failure modes before presenting; vague suggestions waste time.

## Development

- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: Packages that compile to JS (`assistant/`, `gateway/`, `cli/`) use NodeNext module resolution with `.js` extensions on all imports. Bundler-only packages (`clients/web/`, `packages/design-library/`) use `moduleResolution: "Bundler"` and omit `.js` extensions.
- **Package manager**: This is a bun workspace — one root `bun.lock` covers every member (services, `packages/*`, `clients/web`, `clients/macos`). Run `bun install` anywhere in the tree (it resolves to the workspace root), or scope it with name filters like `--filter=@vellumai/assistant` (path filters resolve against the cwd — avoid them). Cross-package deps use `workspace:*`; `overrides`, `patchedDependencies`, and `trustedDependencies` are honored only in the root manifest. Non-members (`clients/chrome-extension`, skills) keep their own lockfiles.

```bash
cd assistant && bun install          # Install dependencies
cd assistant && bunx tsc --noEmit    # Type-check
cd assistant && bun run typecheck:fast  # Fast type-check using tsgo
cd assistant && bun test src/path/to/changed.test.ts  # Run tests
cd assistant && bun run lint         # Lint
```

## Dependencies

This project is licensed under MIT. All dependencies must have MIT-compatible licenses (MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, Unlicense, or similar permissive licenses). Do not add dependencies with copyleft licenses (GPL, AGPL, LGPL, SSPL, EUPL) or proprietary/restrictive licenses without explicit approval.

**Version pinning**: Always use exact versions in `dependencies` and `devDependencies` — no `^` or `~` prefixes. Use `bun add --exact` (or `bun add -E`) when adding packages. The root `bunfig.toml` sets `[install] exact = true` to enforce this by default (bun walks parent directories, so it applies to all packages). **Exception — `peerDependencies`**: Peer deps express compatibility constraints, not installation targets. Use `>=` ranges (e.g. `"react": ">=19.0.0"`) so the consuming app's lockfile controls the resolved version. See [npm docs on peer dependencies](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#peerdependencies) and [Bun docs on `--exact`](https://bun.sh/docs/cli/add#exact).

When adding a new dependency:
1. Check its license in the package's `package.json` or LICENSE file.
2. Dual-licensed packages (e.g. "MIT OR GPL-3.0") are acceptable — we use them under the MIT-compatible option.
3. If unsure about compatibility, flag it in the PR for review.
4. Verify the version in `package.json` is pinned to an exact version (no `^` or `~`).

### Pinning rules

Pin everything that has a version, with the immutable form when one exists:

- **GitHub Actions `uses:`** — pin to a 40-char commit SHA with a trailing `# vX.Y.Z` comment. Look up SHAs via `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`. For actions that only tag bare majors, use `# vN`.
- **Swift SPM** (`Package.swift`) — `.package(url: ..., exact: "X.Y.Z")`. Never `from:` (silently bumps minor/patch).
- **Dockerfile `FROM`** — exact tag plus `@sha256:` digest.
- **Bun toolchain** — `.tool-versions`, `setup.sh`, all workflow `bun-version:` inputs, and every production Dockerfile bun install must share the same exact version.
- **Node toolchain** — `.nvmrc` and every workflow `node-version:` input must share the same exact version. Intentionally separate from Bun.

We do **not** pin: `apt-get` packages (Debian rotates), `brew install` formulae (local-only), Xcode point releases, or GitHub-hosted runner system libs.

### Workflow duplication

`dev-release.yaml` and `release.yml` share inline logic (e.g. "Compute migration ceilings"). When changing logic that lives in both, update both in the same PR.

### Docker build cache

Docker `cache-to: type=gha` must set `ignore-error=true`. The GHA cache is a build-speed optimization, not part of the artifact, so a cache-export failure (e.g. `error writing layer blob: not_found` from an evicted scope) must never fail the build-push step or gate a release. See [Docker cache backends](https://docs.docker.com/build/cache/backends/).

### iOS release

The Capacitor iOS source-of-truth lives in [`clients/ios/`](./clients/ios/) and is built locally from `clients/web/` via `bun run ios:open`. See [`clients/ios/README.md`](./clients/ios/README.md) for the local build flow and full release pipeline mapping.

TestFlight builds are produced by the `release-ios.yaml` reusable workflow in this repo. Both `dev-release.yaml` and `release.yml` call it as a same-repo `uses:` job with `{ environment, version }` inputs. The workflow runs on `macos-15`, installs web dependencies, runs `cap sync ios`, generates the Xcode project via XcodeGen, archives, signs, and uploads to TestFlight.

## Cutting Releases

**Never cut or promote a release automatically — always get explicit manual confirmation from the user first.** This applies to both release steps: dispatching `create-release-branch.yml` (branch cut + staging bake) and dispatching `release.yml` on a `release/v<X.Y.Z>` branch (production deploy). An explicit user request for the release in the current conversation counts as confirmation; otherwise ask and wait. Never dispatch either workflow as a side effect of other work (merging PRs, completing a plan, scheduled or autonomous agent runs), and standing authorizations (e.g. auto-merge) do not extend to releases. The scheduled Tue/Fri branch cut is the only sanctioned automation; production promotion is always a deliberate human action. Process details: `/release` (`.claude/skills/release/SKILL.md`).

## Testing

The full test suite is large and will hang or timeout if run unscoped. **Never run `bun test` without specifying file paths.**

- After making changes, run only the tests relevant to what you changed:
  `cd assistant && bun test src/path/to/file.test.ts`
- To run tests matching a pattern: `cd assistant && bun test src/path/to/file.test.ts --grep "pattern"`
- Use `bunx tsc --noEmit` for full-project type-checking instead of running all tests. In memory-constrained environments, use `bun run typecheck:fast` instead.
- **Regression tests for unfixed bugs**: When adding tests that reproduce a bug or document expected behavior before the fix lands, use `test.todo("description", () => {})` so mainline stays green. Never commit normally-failing `test(...)` cases — red CI blocks merges and erodes signal. Convert `test.todo` to `test` when the implementation PR lands.

## PR Workflow

- **One PR = one logical change.** Each PR is a distinct, mergeable unit of work. Keep diffs reviewable.
- **GitHub issues are for planned work, not paperwork.** When a GitHub issue already exists or the work is non-trivial enough to benefit from a separate planning artifact, link it with `Closes #N` (or `Fixes` / `Resolves`) in the PR body and commit message so GitHub [auto-closes the issue on merge](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue). Don't create retroactive issues just to satisfy a process — if the PR description already captures the *why*, that's the trace.
- **Multi-step efforts.** Use a parent issue with [sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) or sibling issues when the effort has multiple phases. Link intermediate PRs with `Part of #N` or `Related to #N` (no auto-close). Issues earn their keep here — they're the tracking artifact across multiple PRs.
- **Branch name**: include the issue number when one exists, e.g. `123-fix-stale-approvals`.
- **Human attention comments**: After creating a PR with non-routine changes (architectural decisions, security, complex logic, deletions, low confidence), leave a `gh pr comment` highlighting where to focus review and the risk level. Skip for routine changes.
- **Open-source hygiene**: This repo is public. Before opening a PR, review your diff for internal URLs, hardcoded credentials, proprietary infrastructure details, or references to internal services that should not be publicly visible. Generated files (OpenAPI specs, API clients) must be regenerated from committed sources — verify with `bun run generate:openapi` in `assistant/`.

### Notes for Vellum team members

When a Vellum [Linear](https://linear.app/) ticket exists for the work, link it in the PR body and include the identifier in the branch name (e.g. `lum-nnn-fix-foo`). Linear's [GitHub integration](https://linear.app/docs/github#link-using-magic-words) recognizes the same closing keywords plus non-closing words like `Part of` and `Related to` — see the linked docs for the full magic-word list and status-sync behavior. Internal slash-command and tracking-file conventions live in [`.claude/`](./.claude/) docs, not here.

## Keep Docs Up to Date

- **Internal reference**: When modifying slash commands in `.claude/skills/`, update the "Claude Code Workflow" section in `docs/internal-reference.md` to match.
- **Architecture**: When introducing, removing, or significantly modifying a service/module/data flow, update `ARCHITECTURE.md` and impacted domain docs. Mermaid diagrams must reflect current architecture.
- **AGENTS.md**: When a PR establishes a new mandatory pattern or architectural constraint, update `AGENTS.md`. Only for project-wide rules — use code comments for module-scoped patterns.

## Worktrees & Source Control

Never commit worktree directories or worktree artifacts. Git worktrees are local working copies and must remain local. The `.gitignore` already excludes common patterns (`worktrees/`, `.worktrees/`, `.codex-worktrees/`, `*-worktrees/`); if a tool creates worktree directories under a new prefix, add the pattern to `.gitignore` before committing.

## Single Source of Truth

Don't copy-paste logic. Duplicated logic drifts: a bug gets fixed in one copy and left in the others, and the copies diverge silently over time. When the same behavior (a derivation, formatter, guard, validation, fetch/retry sequence, handler) appears in more than one place, extract it into one named function/hook/module that every caller imports — fix it once, it's fixed everywhere.

- Extract on the **second** occurrence, not the fifth — two copies is the signal, not a milestone to pass.
- Share **behavior**, not just shapes: reusing a type while re-implementing the logic around it still drifts.
- Put the extracted code at the right layer (see the package's own docs — e.g. `clients/web/docs/CONVENTIONS.md` "Top-level shared directories"): used by one area → inside it; used by two or more → a shared module. Then delete the originals in the same change.

## Dead Code Removal

Proactively remove unused code during every change. Remove code your change makes unused, clean up adjacent dead code, delete rather than comment out, check for orphaned files. Ask: "After my change, is there any code that nothing calls, imports, or references?" If yes, delete it.

**Exception — migrations**: Database and data migration files must never be deleted, even when the tables or logic they create have moved elsewhere. Migrations run sequentially on existing installs and skipping an entry breaks the chain. When a migration's responsibility has moved (e.g. a table migrated to another database), keep the file in place and add a comment documenting where the logic now lives.

## Code Comments

**Comments describe the present; PRs describe the history.** Code comments should describe what the code *is* and *does* right now — never how it got there, what it replaced, or what changed in a PR. History and reasoning belong in PR descriptions and commit messages, which are the permanent record of *how we got here*.

- Do NOT use temporal language: "now uses", "no longer", "was previously", "instead of the old approach", "after the refactor".
- Do NOT describe the diff: "externalUserId is not consulted", "moved from X to Y", "fix for when Z happens".
- DO describe the code in present tense: "identity is enforced via the (type, address) unique constraint".
- If a comment only makes sense to someone reading the diff, move it to the PR description.

Default to no comment — bias aggressively toward terseness and rely on good naming. Follow the commenting density of the surrounding code.

## Control-Flow Braces

Wrap every `if` / `else` / `for` / `while` / `do…while` body in braces, even a single-statement one-liner. Braces make control flow easy to scan — the block boundary is explicit — and close a common footgun: a second line added under a braceless condition reads as if it sits inside the branch but runs unconditionally. The ESLint `curly` rule flags this in both `assistant/` and `clients/web/` (currently at `warn`); it is fully auto-fixable, so add braces to any control statement you touch.

## Generic Examples

Never include personal user data — real names, emails, phone numbers, account IDs, or other identifying details of specific people — anywhere in the codebase. This covers code, tests, fixtures, documentation, comments, commit messages, and AGENTS.md files. Always use generic placeholders:

- **Names**: `Alice`, `Bob`, `user1`, `Example User`
- **Emails**: `user@example.com` (reserved `example.com`/`example.org` domains)
- **Phone numbers**: fictional numbers from the reserved `555-0100`–`555-0199` range
- **IDs**: `user-123`, `org-abc`, `conv-xyz`

This applies even when the data is the author's own — examples get copied by future contributors, and real data propagates through forks, screenshots, and logs.

**Enforcement:** the pre-commit hook runs `scripts/check-generic-examples.ts` against staged changes, and the commit-msg hook runs the same patterns against the commit message itself (with `#` comment lines and the `git commit -v` scissors region stripped first). The in-repo patterns are shape-based (non-example emails, phones outside `555-01xx`) and quote-anchored — they catch quoted or back-ticked occurrences, not bare prose. Contributors who want to block additional project-specific terms on their own machine can drop them into a local config — see `scripts/generic-examples/README.md`. Inline suppression: add `// generic-examples:ignore-next-line — reason: <why>` on the line above.

## Backwards Compatibility

We have real users — maintain backwards compatibility for all interfaces, persisted state, and data. Never ship a change that silently breaks existing behavior. When a change alters workspace file paths, directory structure, data shapes, namespaces, column schemas, or storage formats, include a migration in the same PR.

**Which migration strategy to use:**

| What changed | Migration type | Location |
|---|---|---|
| Workspace files (renames, moves, format changes under `$VELLUM_WORKSPACE_DIR/`) | Workspace migration | `assistant/src/workspace/migrations/` — append to `WORKSPACE_MIGRATIONS` in `registry.ts` |
| Database schema or data (columns, indexes, backfills) | DB migration | `assistant/src/persistence/migrations/` — add function and register in the `migrationSteps` array in `assistant/src/persistence/steps.ts` |

Migrations must be **idempotent** (safe to re-run if interrupted) and **append-only** (never reorder or remove existing entries). Each new DB migration file takes a fresh numeric prefix — never reuse one; the historical duplicate prefixes are frozen in `assistant/src/persistence/migrations/__tests__/migration-prefix-guard.test.ts`. Test migrations — see `assistant/src/__tests__/workspace-migration-*.test.ts` and `assistant/src/__tests__/db-*.test.ts` for patterns. Flag breaking changes in PR descriptions. If a migration is infeasible, call it out explicitly for human review.

DB migration steps registered in `steps.ts` are checkpointed by function name in the shared `memory_checkpoints` ledger (under the `step:` namespace) and run at most once per database, so each step needs a stable, non-empty name. Add a new migration as its own entry in the list — every step is imported directly and listed individually so it is checkpointed on its own. Never hide a growing set of migrations behind a single stably-named wrapper function (or spread a shared array of them into the list under one import): once that name is checkpointed the whole group is skipped, so anything added to it later never runs. Crash recovery runs unconditionally inside `runMigrationSteps` before the step loop. Rolling a migration back (`rollbackMemoryMigration`) discards all `step:` checkpoints, so a later upgrade re-runs every step and restores any schema a `down()` reversed.

## Multi-Client Assistant State Sync

Persisted assistant state that must converge across macOS, web/Capacitor iOS, and CLI should use the generic `sync_changed` invalidation contract instead of adding a new bespoke server message for each resource. The event payload is `{ type: "sync_changed", tags: [...] }`; tags describe which cached resource is stale, not the new value.

When adding a synced resource:

- Add or reuse a stable tag in `assistant/src/daemon/message-types/sync.ts`.
- Emit the invalidation after the canonical state write succeeds, using `publishSyncInvalidation()` or the existing serialized `broadcastMessage()` path so clients observe invalidations in send order.
- Route tags in native and CLI clients by refetching their existing endpoints; broad reconnect/resume catch-up should perform resource refetches instead of depending on a durable sync ledger.
- Keep live turn and streaming events domain-specific. `sync_changed` is for persisted resource invalidation.
- Keep legacy bespoke events during native rollout and remove them only after adoption is verified. Do not add durable `sync_changes` tables, cursors, or `/sync/changes` endpoints for v1 unless the design is reopened.

See the platform repo's `docs/multi-client-sync.md` for the tag registry and client-routing examples.

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

See `meta/feature-flags/AGENTS.md` for naming, registry, resolver, and the required companion PR in `vellum-assistant-platform` (Terraform).

**Permission controls v2 rule**: Under `permission-controls-v2`, do not introduce new deterministic approval modes for assistant-owned actions beyond the conversation-scoped host computer access gate. No global toggles, no per-tool or per-command approvals, no 10-minute or conversation-wide approval verbs, no wildcard scopes, and no persistent trust-rule UI for v2 flows. If a v2 path needs consent, prefer model-mediated conversation flow unless it is a true host-computer or identity-boundary enforcement case.

## LLM Provider Abstraction

All LLM calls must go through `getConfiguredProvider(callSite)` from `providers/provider-send-message.ts`. The `callSite: LLMCallSite` arg is required so the resolver picks the right per-call-site config. Shipped defaults live in `assistant/src/config/call-site-defaults.ts`. Merge precedence is documented at the `resolveCallSiteConfig` docstring in `assistant/src/config/llm-resolver.ts`; shorthand (low → high) is default → active profile → override profile → site profile → call-site override for non-main-agent call sites, and default → site profile → call-site override → active profile → override profile for `mainAgent` (active and override profiles float above the call-site override since they reflect the user's chat-model selection). Passing `forceOverrideProfile: true` to the resolver floats the override profile above the site profile and call-site override for non-main-agent call sites too — an explicit escape hatch for callers that must run a background call site under a specific conversation's inference profile (e.g. fork-based memory retrospectives matching the source conversation for prompt-cache reuse).

Each LLM call site has a stable identifier (`LLMCallSite` from `assistant/src/config/schemas/llm.ts`). Pick the appropriate call-site ID for the request — the provider layer resolves provider/model/maxTokens/effort/thinking/contextWindow/etc. via `resolveCallSiteConfig` (in `assistant/src/config/llm-resolver.ts`). Non-main-agent call sites deep-merge five layers from highest to lowest precedence: (1) `llm.callSites.<id>` (call-site override), (2) `llm.profiles.<site.profile>` (the call-site's named profile, if any), (3) `llm.profiles.<overrideProfile>` (per-call ad-hoc override passed to the resolver), (4) `llm.profiles.<activeProfile>` (workspace-wide active profile), (5) `llm.default` (required base). `mainAgent` is the exception: the active profile and per-conversation override profile are the user's chat-model selection and therefore override static `llm.callSites.mainAgent` defaults. When `llm.callSites.<id>` is absent, the resolver falls back to shipped defaults from `assistant/src/config/call-site-defaults.ts`, which assign each call site to a profile (`balanced` or `cost-optimized`) with optional per-site tuning overrides. The shipped default's `profile` reference is silently stripped when the target profile isn't defined in `llm.profiles` (backward compat for BYOK setups), when the target profile has `status: "disabled"` (BYOK installs where managed profiles are disabled), or when `overrideProfile` is provided (per-call overrides must win). A missing `site.profile` reference in user config throws because it is statically referenced and validated by schema; missing `overrideProfile`/`activeProfile` references silently fall through because `overrideProfile` is a runtime parameter that cannot be schema-validated and `activeProfile` must degrade gracefully if pointed at a deleted profile mid-edit. Use provider-agnostic language in comments and logs ('LLM' not 'Haiku'/'Sonnet'). Route text generation through the daemon process — direct provider calls discard user context and preferences.

## Skill Isolation

The `assistant/` module must not import from `skills/` via relative paths (e.g. `../skills/<name>/...`), and `skills/` must not import from `assistant/`. Both directions are enforced by `assistant/src/__tests__/skill-boundary-guard.test.ts`.

## Plugin Self-Containment

A plugin owns its state end-to-end: durable data lives in the plugin's storage dir (`InitContext.pluginStorageDir`), schema is created idempotently by the plugin's `init` hook, handles close in `shutdown`, and per-conversation rows are purged in `conversation-deleted`. Plugin state never goes in the main database or the global migration chain (`assistant/src/persistence/migrations/` / `steps.ts`). Full rules, the canonical `image-fallback` example, and the guard test: `assistant/src/plugins/AGENTS.md`. When creating or scaffolding a plugin, follow the `plugin-builder` skill (`skills/plugin-builder/`).

## Tooling Direction

New non-skill tool registrations are strongly discouraged — see `assistant/src/tools/AGENTS.md`.

## System Prompt Minimalism

Adding content to the system prompt is a **last resort**. The system prompt is the most expensive real estate in every request — every token added increases latency, cost, and crowds out user context. Before adding anything to the system prompt, exhaust these alternatives first:

1. **Skills** — Encode behavior in a SKILL.md that the assistant loads on demand.
2. **Config / feature flags** — Use runtime configuration instead of prompt-level instructions.
3. **Code** — If a behavior can be enforced programmatically, enforce it in code.

Tool routing and tool usage guidance belong in the relevant tool description, input schema, or SKILL.md — not in the system prompt. Only put this guidance in the system prompt when it must apply across tools and cannot be localized.

Only add to the system prompt when the behavior cannot be achieved any other way. When you must, keep additions minimal and look for existing content to condense or remove to offset the addition.

CES tools are the only approved exception — see `assistant/src/tools/AGENTS.md` for details.

## User-Facing Terminology: "daemon" vs "assistant"

"Daemon" is an internal implementation detail. In all user-facing text — CLI output, error messages, help strings, SKILL.md instructions that would be relayed to users, README documentation, and UI strings — use **"assistant"** instead of "daemon". Internal code (variable names, class names, file paths, log messages, comments explaining architecture) may continue using "daemon" since users don't see those. When in doubt, ask: "Would a user ever read this?" If yes, say "assistant".

## Qdrant Port Override

Use `QDRANT_HTTP_PORT` (not `QDRANT_URL`) when allocating per-instance Qdrant ports. Setting `QDRANT_URL` triggers QdrantManager's external/remote mode which bypasses the local managed Qdrant lifecycle (download, start, health checks). The CLI deletes `QDRANT_URL` from the environment when spawning instance daemons to ensure local Qdrant management is used.

## Docker Volume Architecture

Docker instances use six per-service volumes enforcing least-privilege at the container level. See `cli/AGENTS.md` for the full volume table, container security posture, meet-bot mount rules, and backup paths.

**Top-level invariants:**

- **Trust rules** are owned by the gateway. In Docker mode (`IS_CONTAINERIZED=true`), the assistant reads/writes trust rules via the gateway's HTTP trust API — no direct filesystem access to `trust.json`.
- **Credentials** are owned by the CES. The assistant and gateway access credentials via the CES HTTP API (`CES_CREDENTIAL_URL`). Neither has filesystem access to `keys.enc` / `store.key`.
- **Meet bots in Docker mode** are not yet supported. The assistant container has no elevated capabilities (`--privileged`, `CAP_SYS_ADMIN` are absent). In bare-metal mode, meet bots are sibling containers on the host's Docker engine.
- **CES socket auth is intentionally absent**: the CES Unix socket (managed-mode `emptyDir` volume or local-mode sibling `ces.sock`) does not require a handshake auth token. All processes on the host/pod are trusted — the security boundary is rules-based access control on credential operations inside CES, not network-level socket auth. Assistant subprocesses (tools, skills) are expected to be able to connect to CES; preventing credential exfiltration requires per-credential policy enforcement, not hiding the socket path.

## Workspace & Secrets

**Never store secrets, API keys, or sensitive credentials in the workspace directory.**

- **Local mode**: Use the credential store (`assistant credentials`) or `GATEWAY_SECURITY_DIR` (resolved by `getGatewaySecurityDir()` in `gateway/src/paths.ts`) for sensitive data. Do **not** create new secrets in the daemon's `protected/` directory — that directory is being phased out; all new security-sensitive files belong in the gateway security dir or CES.
- **Docker mode**: Sensitive files are isolated on dedicated security volumes that only the owning service can access. Trust rules (`trust.json`, `actor-token-signing-key`), capability-token secrets, and other gateway-owned security material live on the gateway security volume (`/gateway-security`). Credential keys (`keys.enc`, `store.key`) live on the CES security volume (`/ces-security`). The assistant and gateway access credentials via the CES HTTP API (`CES_CREDENTIAL_URL`), and the assistant accesses trust rules via the gateway's trust HTTP API. Neither the assistant nor the gateway has direct filesystem access to the other service's security volume.
- **The daemon must never read from `GATEWAY_SECURITY_DIR`** or any gateway-owned directory. Any data the daemon needs from the gateway (e.g. capability token verification, feature flags, trust rules) must flow through IPC or HTTP APIs.
- **Do not access the user's `~/.vellum` directory from client packages** (`clients/chrome-extension/`). Clients should read configuration from their own package directory or from `GATEWAY_SECURITY_DIR`. Existing `~/.vellum` references in client code are legacy and should be removed.

## Release Notes

There is currently **no release-note surfacing mechanism**. The update-bulletin feature (workspace migrations appending to `<workspace>/UPDATES.md`, processed by a background conversation at daemon startup) was removed — it ran an LLM conversation on container start before the user did anything. Do not add new `0XX-release-notes-*` workspace migrations; the guard test `workspace-release-notes-feature-flag-guard.test.ts` freezes the historical set. If a release needs user-facing notes, design an explicit surfacing mechanism first (and make it on-demand, not boot-triggered).

## No LLM Work at Daemon Startup

The daemon must not invoke LLM providers at startup or on unconditional timers — boot-time generation costs the user money before they have asked for anything. Generated content that clients display (home greeting, suggested prompts, conversation starters, identity intro) is produced on demand: GET handlers serve cached content and trigger a bounded, single-flight, TTL-gated background refresh only when a client actually fetches (see the GET-idempotency exceptions in `assistant/src/runtime/AGENTS.md`). User-facing scheduled work (heartbeat, user-created schedules) is exempt — it is explicit, user-visible, and user-disableable.

## Companion Repos

- **[`vellum-assistant-platform`](../vellum-assistant-platform)** — Django backend that manages platform-hosted ("managed") assistants. Handles authentication (WorkOS OIDC), organization management, assistant lifecycle, and runtime proxying. The desktop app authenticates against it and proxies all runtime traffic through it. Stack: Python 3.14, Django, DRF, PostgreSQL, Redis/Valkey. See `../vellum-assistant-platform/AGENTS.md` for development instructions.

When making changes that could affect the cloud platform, review the sibling `../vellum-assistant-platform` repo for compatibility and required follow-up updates. High-risk change areas include:
- HTTP server behavior and API contracts.
- Stored file and directory structure changes (workspace paths, on-disk formats, exports/imports, migrations).
- Dockerfile or container runtime/build changes.
- **Feature flags**: Adding a flag to `meta/feature-flags/feature-flag-registry.json` requires a companion PR in `vellum-assistant-platform` to provision the flag in Terraform. See the [Assistant Feature Flags](#assistant-feature-flags) section.

## Build Environment (`VELLUM_ENVIRONMENT`)

`VELLUM_ENVIRONMENT` identifies the runtime environment for all clients (Electron macOS app, CLI, Chrome extension). It's embedded at build time by each platform's build tooling, or injected via `--define` for the Chrome-ext bundler. CI/devs can override by exporting it before building; per-client default-resolution logic lives in each client's build script.

| Value | Use cases |
|---|---|
| `local` | Always built from local source. Enable developer-only features. |
| `dev` | Artifacts from `main`. Connected to dev platform; skip production guards. |
| `test` | Stub external services, use test fixtures. |
| `staging` | QA against staging before production rollout. Default for release-branch builds. |
| `production` | Full production behavior, no developer shortcuts. |

**Guidelines**:
- Use it for behavior that varies by deployment target (image builds, telemetry sampling, API base URLs). Don't substitute it for feature flags (those gate per-user/org; this gates per-deployment).
- Don't gate on `#if DEBUG` / `RELEASE` compiler flags when the distinction is really deployment environment. A debug build pointed at staging is still `staging`.
- Client `build.sh` scripts must be self-contained — install their own deps before building, not via `setup.sh` / `vel up` / CI workflows.

## Sentry & Linear Integration

Error reporting uses Sentry. The daemon/runtime (Node) project's DSN is configured via the `SENTRY_DSN_ASSISTANT` environment variable — see `.env.example`.

### Sentry projects & DSNs

Surfaces map onto Sentry projects as below. The Electron renderer reports to the macOS project, sharing the `SENTRY_DSN_MACOS` secret with the main process. Per-host flavor + DSN selection in the shared clients/web bundle is live: `flavor.ts` `selectSentryFlavor()` picks the capacitor flavor on native iOS and the react flavor everywhere else (web + Electron renderer); `sentry-init.ts` `resolveDsn()` picks `VITE_SENTRY_DSN_MACOS` (Electron) / `VITE_SENTRY_DSN_IOS` (iOS) / `VITE_SENTRY_DSN` (web). All flavors share one `options` object (ignoreErrors, denyUrls, beforeBreadcrumb URL sanitize, enhanceFetchErrorMessages, attachStacktrace) so PII/noise filtering is uniform. An empty DSN no-ops.

| Surface | Project | DSN source | Delivered via |
| --- | --- | --- | --- |
| Web SPA | `vellum-assistant-web` | `VITE_SENTRY_DSN` (vars) | web build |
| Electron main | `vellum-assistant-macos` | `SENTRY_DSN_MACOS` (secret) → `__SENTRY_DSN_MACOS__` | macOS build define |
| Electron renderer | `vellum-assistant-macos` | `SENTRY_DSN_MACOS` (secret) → `VITE_SENTRY_DSN_MACOS` | macOS build |
| iOS webview + native | `vellum-assistant-ios` | `SENTRY_DSN_IOS` (secret) → `VITE_SENTRY_DSN_IOS` | web-SPA build (loaded at runtime on iOS) |
| Assistant daemon | (unchanged) | `SENTRY_DSN_ASSISTANT` | runtime env |

The iOS DSN is baked into the deployed web SPA bundle rather than the iOS build, because the iOS app runs the deployed SPA via `server.url` (see `clients/web/capacitor.config.ts`) and bundles no web assets at `cap sync`.

The Electron renderer uses `@sentry/react` (not `@sentry/electron/renderer`): `@sentry/electron` pins `@sentry/core` 10.50 while `@sentry/capacitor` pins `@sentry/react`/`@sentry/browser` 10.52, and Sentry's current-client carrier is version-specific, so an `@sentry/electron/renderer` client couldn't see `@sentry/react` captures. Renderer native crashes still reach `vellum-assistant-macos` via `@sentry/electron/main` (separate process).

**Version pins**: `@sentry/react`/`@sentry/browser` are pinned to 10.52.0 to satisfy `@sentry/capacitor`'s exact peer; `@sentry/electron` (Electron main process only) is on its own 10.50 line. Bumping any one requires checking the others.

**Sentry CLI**: Use the newer `sentry` CLI (not the legacy `sentry-cli`). Install from `https://cli.sentry.dev/install`. Authenticate with `sentry auth login`.

## CLI ↔ Daemon Communication

CLI commands that need to invoke daemon-side state (conversations, wake, in-memory lookups) call into the daemon over the Unix domain socket via `cliIpcCall()` from `assistant/src/ipc/cli-client.ts`. Add a route file in `assistant/src/ipc/routes/` and register it in `routes/index.ts` — `AssistantIpcServer` auto-registers from the index. File-based signals and the daemon HTTP port are deprecated for new CLI→daemon interactions.

For routes shared between HTTP and IPC, and for the current wire-protocol details (length-prefixed binary framing with JSON envelopes, plus binary/chunked response shapes), see `assistant/CLAUDE.md` § Route architecture and § CLI ↔ daemon communication protocol.

When publishing domain/live events from inside the daemon process, call the `assistantEventHub` singleton directly rather than adding an HTTP endpoint. For persisted multi-client state invalidation, use `publishSyncInvalidation()` (see Multi-Client Assistant State Sync).

## See Also

- **HTTP API patterns & new endpoints**: `assistant/src/runtime/AGENTS.md`
- **Error handling conventions**: `assistant/docs/error-handling.md`
- **Notification pipeline**: `assistant/src/notifications/AGENTS.md`
- **Trust & guardian invariants**: `assistant/src/approvals/AGENTS.md`
