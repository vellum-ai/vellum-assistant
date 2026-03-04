# Vellum Assistant — Agent Instructions

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `assistant/` — Main backend service (Bun + TypeScript)
- `gateway/` — Channel ingress gateway (Bun + TypeScript)
- `clients/` — Client apps (macOS/iOS/etc). See `clients/AGENTS.md` and platform docs like `clients/macos/CLAUDE.md`.
- `scripts/` — Utility scripts
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`). Most commands are shared from [`claude-skills`](https://github.com/vellum-ai/claude-skills) via symlinks; repo-local commands (`/update`, `/release`) live in `.claude/skills/<name>/` as local skill directories.

## Conventions

- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Package manager**: Use `bun install` for dependencies, `bun test` for tests, `bunx tsc --noEmit` for type-checking.
- **Install dependencies**: `cd assistant && bun install` (each package has its own `bun.lock`).

## Development

```bash
# Install dependencies
cd assistant && bun install

# Type-check
cd assistant && bunx tsc --noEmit

# Run tests
cd assistant && bun test

# Lint
cd assistant && bun run lint
```

## Keep the README up to date

Whenever you modify, add, or remove a slash command in `.claude/commands/`, you MUST update `README.md` to reflect the change. The README's "Slash Commands" section should always match the current set of commands. Update the TLDR description if the command's purpose changed, add new entries for new commands, and remove entries for deleted commands.

## Comments

Comments should explain **why** something is done and provide non-obvious context, not describe what the code does. If the code is clear enough to understand on its own, it doesn't need a comment. Reserve comments for surprising behavior, subtle invariants, workarounds, and design rationale.

## Keep the Architecture Diagram up to date

Whenever you introduce, remove, or significantly modify a service, module, or data flow, you MUST update the relevant architecture docs to reflect the change. Keep the root `ARCHITECTURE.md` index aligned, and update impacted domain docs (for example `assistant/ARCHITECTURE.md`, `gateway/ARCHITECTURE.md`, `clients/ARCHITECTURE.md`, or `assistant/docs/architecture/*`). Mermaid diagrams should always accurately represent the current system architecture, including new services, IPC message types, storage locations, and data flows.

## Keep AGENTS.md up to date

When your PR establishes a new mandatory pattern, convention, or architectural constraint that other agents must follow, update `AGENTS.md` in the same PR. Examples: introducing a new abstraction layer that all callsites must use, adding a guard test that enforces an import rule, or changing how a subsystem handles failure modes. If the pattern is only relevant within a single file or module, a code comment is sufficient — only add to `AGENTS.md` when the rule applies project-wide.

## Slash Commands — TLDR

Most commands are shared from the [`claude-skills`](https://github.com/vellum-ai/claude-skills) repo via symlinks. Repo-local commands (`/update`, `/release`) live in `.claude/skills/<name>/` as local skill directories. After cloning, run `path/to/claude-skills/setup` to create the symlinks.

| Command | What it does |
|---|---|
| `/work` | Pick one task from `.private/TODO.md` (or a user-provided task), implement it, open a PR, squash-merge it, and update tracking files. |
| `/do <description>` | Implement a described change in an isolated worktree, ship it to main via a squash-merged PR, and clean up. The PR body includes the original prompt for traceability. |
| `/safe-do <description>` | Like `/do` but creates a PR without auto-merging — pauses for human review. Keeps the worktree in place for addressing feedback. The PR body includes the original prompt for traceability. |
| `/swarm [workers] [max-tasks] [--namespace NAME]` | Process `.private/TODO.md` in parallel — one worktree per agent, auto-merge PRs (auto-assigned to the current user), respawn agents until the list is empty. Uses `--namespace` to prefix branch names and avoid collisions with other parallel swarms (auto-generates a random 4-char hex if omitted). When `--namespace` is explicitly provided, only TODO items prefixed with `[<namespace>]` are processed; when auto-generated, all items are processed. |
| `/blitz <feature>` | End-to-end feature delivery: plan, create GitHub issues on a project board, swarm-execute in parallel, gate each PR on Codex/Devin review approval before merging (per-PR feedback loops with up to 3 fix cycles), then run a recursive sweep loop (check reviews, swarm to address feedback, review and merge feedback PRs, repeat) until all PRs — including transitive feedback PRs — are fully reviewed. Supports `--auto`, `--workers N`, `--skip-plan`, `--skip-reviews`. Pass `--skip-reviews` to merge immediately without waiting for reviews (default is to wait). Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. |
| `/safe-blitz <feature>` | Like `/blitz` but merges milestone PRs into a feature branch instead of main, with per-milestone direct-push feedback loops (push fixes to milestone branch, re-request reviews, repeat until clean or 3 cycles) and an automatic final sweep (no approval prompt) before opening a PR for manual review. Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. Supports `--workers N`, `--skip-plan`, `--branch NAME`. |
| `/safe-blitz-done [PR\|branch]` | Finalize a safe-blitz — squash-merge the feature branch PR into main, set the project issue to Done, close the issue, and clean up locally. Auto-detects from current branch, open `feature/*` PRs, or project board. |
| `/mainline [title]` | Ship the current uncommitted changes to main via a squash-merged PR. The PR body includes the original prompt (if provided) for traceability. |
| `/ship-and-merge [title]` | Create a PR, wait for Codex and Devin reviews, fix valid feedback (up to 3 rounds), and squash-merge once approved. The PR body includes the original prompt (if provided) for traceability. |
| `/brainstorm` | Read through the codebase and `.private/TODO.md`, generate a prioritized list of improvements, and update the TODO after user approval. |
| `/check-reviews [--namespace NAME]` | Check every PR in `.private/UNREVIEWED_PRS.md` for Codex and Devin reviews; add feedback items to TODO and remove fully-reviewed PRs. When `--namespace` is provided, only PRs whose head branch starts with `swarm/<namespace>/` are processed, and TODO items are prefixed with `[<namespace>]`. When omitted, all PRs are processed, but TODO items are still namespaced if the PR's branch matches `swarm/<NAME>/...` (inferred from the branch name). |
| `/execute-plan <plan-file>` | Execute a multi-PR rollout plan from `.private/plans/` sequentially — implement, validate, and mainline each PR in order. The PR body includes the full plan content for traceability. |
| `/safe-execute-plan <file>` | Start a plan from `.private/plans/` — implements the first PR, creates it (without merging), and stops to wait for human review. The PR body includes the full plan content for traceability. |
| `/safe-check-review [file]` | Check the active plan PR for review feedback from codex/devin/humans. Addresses requested changes, waits if reviews are pending. |
| `/resume-plan [file]` | Merge the current plan PR, implement the next one, create it, and stop again. Repeats until the plan is complete. The PR body includes the full plan content for traceability. |

| `/update` | Pull latest from main, use `vellum ps/sleep/wake` to manage daemon and gateway lifecycle, rebuild/launch the macOS app, and print a startup summary. Uses `vellum sleep` (directory-agnostic global stop) to quiesce processes, then `vellum wake` (from current checkout) to restart. |

**Lifecycle docs drift guard:** A guard test (`lifecycle-docs-guard.test.ts`) enforces that repo-local commands live in `.claude/skills/` (not `.claude/commands/`), key docs reference `vellum` CLI lifecycle commands, and stale daemon startup patterns (`bun run src/index.ts daemon start`) are not used as primary instructions outside dev-only contexts.

## Linear Ticket Hygiene

When working on a task sourced from a Linear ticket (via the Linear MCP), keep the ticket status in sync with your progress:

- **Branch naming**: Include the Linear issue ID in the branch name (e.g., `feat/ABC-123-add-widget`). Linear automatically links branches, commits, and PRs that reference the issue ID.
- **Commit messages**: Reference the issue ID in commits (e.g., `feat: add widget [ABC-123]`) so Linear links them automatically.
- **Start of work**: Move the ticket to "In Progress" (or the equivalent active status).
- **PR created**: Move the ticket to "In Review" if applicable. If you used the issue ID in the branch name, Linear will link the PR automatically — otherwise add the PR link manually.
- **Work completed / PR merged**: Move the ticket to "Done".
- **Blocked or abandoned**: Update the ticket status accordingly and leave a comment explaining why.

Treat the Linear ticket as the source of truth for task status. Don't leave tickets in a stale state — if you touched it, update it.

## Track merged PRs

Whenever you merge a PR, you MUST append its URL to `.private/UNREVIEWED_PRS.md` so that `/check-reviews` can pick it up for review triage.

## Implementing new functionality
Before implementing new functionality do a quick check to see if the new feature has already been implemented

## Dead Code Removal

Proactively remove unused code during every change. Dead code accumulates quickly and makes the codebase harder to understand, navigate, and modify.

Concretely:
- **Remove code that your change makes unused.** When refactoring, replacing, or deleting a feature, trace the code you're touching and delete anything that is no longer referenced — functions, classes, imports, files, config entries, test helpers, and type definitions.
- **Clean up adjacent dead code you encounter.** If you notice unused code near the code you're modifying, remove it in the same PR. Don't leave it for a future cleanup pass.
- **Delete rather than comment out.** Git history preserves old code. Commented-out code is noise — remove it.
- **Remove fully-rolled-out feature flags.** When a feature flag is permanently enabled and no longer gating behavior, remove the flag check and the associated conditional branches.
- **Don't leave "TODO: clean up later" markers.** If code is unused now, remove it now. Deferred cleanup rarely happens.
- **Check for orphaned files.** After removing a module or capability, verify that no files, tests, scripts, or skill definitions were left behind that only served the removed code.

Ask: "After my change, is there any code that nothing calls, imports, or references?" If yes, delete it.

## Extensibility Principle

Vellum is a **general-purpose assistant**, not a single-purpose tool. When adding a new capability (e.g., personalized email responses, context-aware summarization, smart scheduling), build it as a **reusable, extensible primitive** that works across contexts — not a narrow solution wired to one specific use case.

Concretely:
- Extract the underlying capability (e.g., "personalize text using user context") into a composable building block (skill, tool, or utility) that other features can reuse.
- Parameterize inputs and outputs rather than hardcoding them to a single workflow.
- If a capability already exists in a general form, extend it rather than building a parallel special-purpose version.
- Ask: "If someone wanted this same capability in a different context, would they be able to use what I'm building?" If not, generalize it.

## Code Review Checklist

When reviewing PRs (applies to all reviewers — Codex, Devin, and humans), flag these in addition to standard code quality:

- **Special-purpose capability added:** When a PR introduces a capability that is specific to one use case (e.g., a dedicated Google Cloud OAuth flow for Gmail), flag it for human review — don't reject it. Sometimes special-purpose implementations are the right call (e.g., making a painful setup "magical" requires specificity). The reviewer's job is to surface it so a human can decide whether it should be generalized or is fine as-is.
- **Duplicate capability:** The PR adds functionality that already exists in a general form elsewhere in the codebase. Suggest reusing the existing implementation.
- **Missing parameterization:** Inputs, outputs, or behaviors are hardcoded when they should be configurable or context-driven.

## Human Attention Comments on PRs

After creating a PR, consider whether it contains anything that genuinely warrants focused human review. If it does, leave a single comment highlighting where attention is most needed. This helps humans quickly triage PRs.

**This is not mandatory.** Skip the comment entirely for routine, low-risk PRs that follow existing patterns — don't add noise. Only comment when you believe a human should look closely at specific parts of the diff.

**When to comment:**
- Architectural decisions or new patterns that set precedent
- Security-sensitive changes (auth, permissions, secrets, input validation)
- Complex business logic with subtle edge cases
- Changes that touch critical paths (data pipelines, payment flows, etc.)
- Deletions or removals of existing functionality
- Areas where you are least confident in the implementation

**When to skip:** Routine changes — renaming, formatting, boilerplate, straightforward additions that follow existing patterns exactly, or changes you are fully confident in.

**How:** `gh pr comment <number> --body "<comment>"`

**Comment format:**

```
## 👀 Where to focus your review

- **<file_path or area>**: <why this needs attention — e.g., "New architectural pattern that sets precedent", "Security-sensitive change to auth flow", "Complex logic with subtle edge cases">
- ...

**Risk level:** <Medium | High> — <one-sentence explanation of overall risk>
```

## Public API / Webhook Ingress

All inbound HTTP endpoints must be routed through the gateway (`gateway/`). See `gateway/AGENTS.md` for full rules including gateway-only API consumption, SKILL.md patterns, and channel identity vocabulary. Guard test: `gateway-only-guard.test.ts`.

## Assistant Identity Boundary

The daemon uses a single fixed internal scope constant — `DAEMON_INTERNAL_ASSISTANT_ID` (`'self'`), exported from `assistant/src/runtime/assistant-scope.ts` — for all assistant-scoped storage and routing. Public/external assistant IDs (assigned during hatch, invite links, or platform registration) are an **edge concern** owned by the gateway and platform layers.

**Rules:**
- Daemon code (`assistant/src/runtime/`, `assistant/src/daemon/`, `assistant/src/memory/`, `assistant/src/approvals/`, `assistant/src/calls/`, `assistant/src/tools/`) must never derive internal scoping from externally-provided assistant IDs. Use `DAEMON_INTERNAL_ASSISTANT_ID` instead.
- The `normalizeAssistantId()` function (in `util/platform.ts`) is for gateway/platform use only — do not import or call it in daemon scoping modules.
- The daemon HTTP server uses flat `/v1/<endpoint>` paths. Do not add assistant-scoped routes (`/v1/assistants/:assistantId/...`) to the daemon.
- Guard tests in `assistant/src/__tests__/assistant-id-boundary-guard.test.ts` enforce these rules.

## Assistant Feature Flags

Assistant feature flags are the canonical assistant-scoped flagging mechanism for enabling/disabling assistant behavior across the system. They are declaration-driven and not limited to skills.

- **Canonical key format:** `feature_flags.<flagId>.enabled`. All new code must use this format. The legacy `skills.<id>.enabled` format is no longer supported.
- **Unified registry:** All declared flags live in the unified feature flag registry at `meta/feature-flags/feature-flag-registry.json`. Each entry has `id`, `scope`, `key`, `label`, `description`, and `defaultEnabled`. Assistant-scope flags are filtered by `scope: "assistant"`. Keys declared in this registry participate in UI exposure and have registry-defined defaults. Undeclared keys still respect persisted config overrides but default to enabled when no override exists.
- **Resolver:** The canonical resolver in `assistant/src/config/assistant-feature-flags.ts` resolves effective flag state by checking (in order): explicit config overrides (`assistantFeatureFlagValues`), registry defaults (for declared keys), and finally `true` (for undeclared keys with no persisted override).
- **Gateway API:** The gateway owns the `/v1/feature-flags` REST API for reading and mutating flags. The GET response includes `key`, `label`, `enabled`, `defaultEnabled`, and `description` for each flag. New writes are stored in the `assistantFeatureFlagValues` config section using canonical keys.
- **Guard tests:** Guard tests enforce:
  1. All feature flag key literals in production code use the canonical `feature_flags.<id>.enabled` format (not the legacy `skills.<id>.enabled` format).
  2. All assistant-scope flag keys in the unified registry use the canonical format.
  3. All literal keys passed to `isAssistantFeatureFlagEnabled()` in production code are declared in the unified registry.

When adding a new assistant feature flag, declare it in the unified registry at `meta/feature-flags/feature-flag-registry.json` with `scope: "assistant"`. When referencing a feature flag in code, always use the canonical key format.

## LLM Provider Abstraction

All LLM calls in production code **MUST** go through the provider abstraction layer — never import `@anthropic-ai/sdk` (or any other provider SDK) directly.

- Use `getConfiguredProvider()` from `providers/provider-send-message.ts` to obtain a provider instance, then call `provider.sendMessage(...)`.
- Use the helper utilities (`extractText`, `extractToolUse`, `userMessage`, `createTimeout`, etc.) from the same module.
- A guard test (`no-direct-anthropic-sdk-imports.test.ts`) enforces this — any new direct SDK import in production code will fail CI.
- The only file allowed to import `@anthropic-ai/sdk` directly is `providers/anthropic/client.ts`.

### Model intents over hardcoded model IDs

Do not hardcode provider-specific model names (e.g., `claude-haiku-4-5-20251001`, `gpt-4o-mini`). Instead, use `modelIntent` in the config to express **what you need** from the model:

- `'latency-optimized'` — fastest response (e.g., classifiers, triage, icon generation)
- `'quality-optimized'` — best reasoning (e.g., summaries, complex analysis)
- `'vision-optimized'` — best vision/multimodal capabilities

The `RetryProvider` resolves intents to provider-specific models automatically. An explicit `model` in config takes precedence over `modelIntent`.

### Provider-agnostic language

Use generic terms in comments, logs, and variable names — write "LLM" instead of "Haiku"/"Sonnet"/"Claude". The system is multi-provider; naming should reflect that.

### Text generation goes through the assistant daemon

When you need to generate text (summaries, replies, rewrites, classifications, etc.), route the request through the assistant/daemon process — do **not** make direct calls to an LLM provider or side-step the daemon.

Why: the assistant daemon carries context, identity, and user preferences. Text produced through the daemon is shaped by all of that, which is what we want in almost every case. Calling a provider directly discards that context and produces generic output.

There may be narrow cases where a direct provider call is acceptable (e.g., a low-level embedding or a purely mechanical transformation with no user-facing prose). If you believe your case qualifies, call it out explicitly in the PR description and get sign-off — don't silently bypass the daemon.

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

Do not add new tool registrations using the `class ____Tool implements Tool {` pattern.

Prefer skills in `assistant/src/config/bundled-skills/` that teach the model how to use CLI tools directly.

Keep the system prompt as minimal as possible. Avoid adding instructions about how to use tools; only document what tools exist when they are basic, primitive, and universally useful. Prefer CLI programs that the assistant can progressively learn to use via `--help`.

## Skill Independence

New skills **MUST** be self-contained and portable. A skill should not be tightly coupled to daemon internals, registered tool implementations, repo-specific TypeScript modules, or any other part of this codebase.

Concretely:
- **No coupling to daemon tools or internals.** Do not reference or depend on registered `Tool` classes, daemon IPC message types, internal TypeScript modules, or any runtime-specific APIs from within a skill. If the daemon were swapped out, the skill should still work.
- **Stand on your own.** A skill's SKILL.md instructions should be understandable and executable without knowledge of the daemon's implementation. Interact with the system through CLI programs first (especially for config/status retrieval), gateway HTTP APIs only when needed for control-plane actions, or standard Unix tools — not through internal abstractions.
- **Use a `scripts/` folder for supporting logic.** When a skill needs custom logic beyond what a one-liner CLI command provides, bundle it as an executable script in the skill's `scripts/` directory per the [skill.md spec](https://skill.md). Scripts should be self-contained with inline dependency declarations (PEP 723 for Python, `npm:` specifiers for Deno, auto-install for Bun) so no separate install step is required.
- **No interactive prompts in scripts.** Agents run in non-interactive shells. Accept all input via CLI flags, environment variables, or stdin. Include `--help` output so the agent can discover the script's interface.
- **Relative paths only.** Reference scripts, assets, and reference files using paths relative to the skill directory root — never use absolute paths or paths that reach outside the skill directory into the broader repo.

Ask: "Could this skill be copied into a completely different project and still work?" If not, decouple it.

## Assistant-Driven Judgement

All judgement calls that affect the user's experience should be made by the assistant through the daemon process — not by hard-coded logic or deterministic heuristics in application code.

Concretely:
- **Prefer LLM judgement over if/else.** When a decision requires interpreting intent, tone, priority, relevance, or any other subjective quality, route it through the assistant rather than encoding a fixed rule. Hard-coded heuristics are brittle and cannot adapt to context the way the model can.
- **Reserve deterministic logic for mechanical operations.** Parsing, validation, data transformation, access control, and protocol enforcement are fine as code. The line is: if the decision requires understanding meaning or context, it belongs to the assistant; if it's purely structural or policy-enforced, code is appropriate.
- **Don't approximate the assistant with heuristics.** If you find yourself writing a cascade of string matches, keyword checks, or scoring functions to simulate what the model would decide, stop — that's a sign the decision should be delegated to the daemon instead.
- **Treat the daemon as the judgement layer.** The assistant carries user context, preferences, conversation history, and identity. Decisions routed through it benefit from all of that. Decisions made in application code discard it.

When in doubt, ask: "Am I encoding a judgement that the assistant could make better with context?" If yes, route it through the daemon.

## Migration Guidance

When touching existing tool-based flows, migrate behavior toward skill-driven CLI usage instead of adding new registered tools.

Reasoning: every registered tool increases model context overhead, while the model can usually learn CLI usage from skills on demand and install missing CLI dependencies when needed.

## Release Update Hygiene

When shipping a release that includes user-facing or assistant-facing changes:

1. **Update the template**: Edit `assistant/src/config/templates/UPDATES.md` with freeform markdown describing what changed and how it affects behavior or capabilities.
2. **Leave empty for no-op releases**: If the release has no relevant changes, keep the template empty or comment-only (lines starting with `_` are stripped).
3. **Don't modify workspace files directly**: The workspace `UPDATES.md` is managed by the daemon's startup sync — never edit `~/.vellum/workspace/UPDATES.md` manually.
4. **Checkpoint keys**: `updates:active_releases` and `updates:completed_releases` in the `memory_checkpoints` table track bulletin lifecycle. Don't manipulate these directly.
