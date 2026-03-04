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

All inbound HTTP endpoints — APIs, webhooks, OAuth callbacks, or any route that receives requests from the internet — **MUST** be routed through the **gateway** (`gateway/`). Never add ingresses, routes, or listeners directly to the daemon runtime (`assistant/`).

Concretely:
- Define new routes in the gateway and have the gateway forward requests to the assistant over the internal IPC/transport.
- The gateway's public URL is controlled by the **public ingress URL** setting. All externally-facing URLs you generate or advertise (callback URLs, webhook registration URLs, etc.) must be derived from this setting — never hardcode a hostname or port.
- The daemon should remain unreachable from the public internet. It only receives traffic from the gateway over the internal network.

Why: the gateway is the single point of ingress, handling TLS termination, auth, rate limiting, and routing. Exposing the daemon directly bypasses these protections and breaks the deployment model.

### Gateway-Only API Consumption

All assistant API requests from clients, CLI, skills, and user-facing tooling **MUST** target gateway URLs. Never construct URLs using the daemon runtime port (`7821`) or `RUNTIME_HTTP_PORT` for external API consumption.

**Exception boundary:** The gateway service itself may call the runtime internally. Tests may use direct runtime URLs for isolated unit/integration scenarios. Intentional local daemon-control paths are exempt:
- `clients/shared/IPC/DaemonClient.swift`
- `clients/macos/vellum-assistant/App/AppDelegate.swift` (`localHttpEnabled`)
- `clients/macos/vellum-assistant/Features/Settings/SettingsConnectTab.swift` (health probe)

**Migration rule:** If a needed endpoint is not available at the gateway, add a gateway route/proxy first, then consume it. Do not work around a missing gateway endpoint by hitting the runtime directly.

**Ban on hardcoded runtime hosts/ports:** Do not embed `localhost:7821`, `127.0.0.1:7821`, or runtime-port-derived URLs in docs, skills, or user-facing guidance. Always reference gateway URLs instead. A CI guard test (`gateway-only-guard.test.ts`) enforces this — any new direct runtime URL reference in production code or skills will fail CI.

**SKILL.md retrieval contract:** For config/status retrieval in bundled skills, use `bash` + canonical CLI surfaces. Start with `vellum config get` for generic config keys and secure credential surfaces (`credential_store`, `vellum keys`) for secrets. Use domain read commands (for example `vellum integrations ...`, `vellum email status ...`) where those domain surfaces exist. Do not use direct gateway `curl` (or manual `Authorization: Bearer $GATEWAY_AUTH_TOKEN`) for read-only retrieval paths. Do not use keychain lookup commands (`security find-generic-password`, `secret-tool`) in SKILL.md. `host_bash` is not allowed for Vellum CLI retrieval commands unless a documented exception is intentionally allowlisted.

**SKILL.md proxied outbound pattern:** For outbound third-party API calls from skills that require stored credentials, default to `bash` with `network_mode: "proxied"` and `credential_ids` instead of manual token/keychain plumbing. This keeps credentials out of chat and enforces credential policies consistently.

**SKILL.md gateway URL pattern:** For gateway control-plane writes/actions that are not exposed through a CLI read command, use `$INTERNAL_GATEWAY_BASE_URL` (injected by `bash` and `host_bash`). `$GATEWAY_BASE_URL` is also injected and resolves to the configured public ingress URL when set (falling back to the internal gateway target). Do not hardcode `localhost`/ports in skill examples, and do not instruct users/agents to manually export either variable from Settings.

## Assistant Identity Boundary

The daemon uses a single fixed internal scope constant — `DAEMON_INTERNAL_ASSISTANT_ID` (`'self'`), exported from `assistant/src/runtime/assistant-scope.ts` — for all assistant-scoped storage and routing. Public/external assistant IDs (assigned during hatch, invite links, or platform registration) are an **edge concern** owned by the gateway and platform layers.

**Rules:**
- Daemon code (`assistant/src/runtime/`, `assistant/src/daemon/`, `assistant/src/memory/`, `assistant/src/approvals/`, `assistant/src/calls/`, `assistant/src/tools/`) must never derive internal scoping from externally-provided assistant IDs. Use `DAEMON_INTERNAL_ASSISTANT_ID` instead.
- The `normalizeAssistantId()` function (in `util/platform.ts`) is for gateway/platform use only — do not import or call it in daemon scoping modules.
- The daemon HTTP server uses flat `/v1/<endpoint>` paths. Do not add assistant-scoped routes (`/v1/assistants/:assistantId/...`) to the daemon.
- Guard tests in `assistant/src/__tests__/assistant-id-boundary-guard.test.ts` enforce these rules.

### Channel Identity Vocabulary

Gateway inbound events use a channel-discriminated union model (`GatewayInboundEvent`) with explicit identity fields:

- **`conversationExternalId`**: Delivery/thread address (e.g., Telegram chat ID, SMS phone number). Used for conversation binding and message routing. **Not** used for trust classification.
- **`actorExternalId`**: Sender identity (e.g., Telegram user ID, WhatsApp phone number). Used for trust classification, guardian binding, and ACL enforcement. **Required** for all public channel ingress.
- **"conversation"** is canonical vocabulary for delivery addresses. "thread" is reserved for provider-specific fields (Slack `thread_ts`, email thread IDs).
- **"actor"** is canonical vocabulary for sender identity.

Trust/guardian decisions must be keyed on `actorExternalId` only — never fall back to `conversationExternalId` for actor identity.

Physical DB column names (`externalUserId`, `externalChatId`) are unchanged; the rename is at the API/type layer only.

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

## Approval Flow Resilience

- **Rich delivery failures must degrade gracefully.** If delivering a rich approval prompt (e.g., Telegram inline buttons) fails, fall back to plain text with parser-compatible instructions (e.g., `Reply "yes" to approve`) — never auto-deny.
- **Non-rich channels** (SMS, http-api) receive plain-text approval prompts without approval metadata payloads.
- **Race conditions:** Always check whether a decision has already been resolved before delivering the engine's optimistic reply. If `handleChannelDecision` returns `applied: false`, deliver an "already resolved" notice and return `stale_ignored`.
- **Requester self-cancel:** A requester with a pending guardian approval must be able to cancel their own request (but not self-approve).
- **Unified guardian decision primitive:** All guardian decision paths (callback buttons, conversational engine, legacy text parser, requester self-cancel) must route through `applyGuardianDecision()` in `assistant/src/approvals/guardian-decision-primitive.ts`. Do not inline decision logic (approve_always downgrade, approval record updates, grant minting) at individual callsites.

## HTTP API Patterns

### Sending messages

The single HTTP send endpoint is `POST /v1/messages`. Key behaviors:
- **Queue if busy**: When the session is processing, messages are queued and processed when the current agent turn completes. No 409 rejections.
- **Fire-and-forget**: Returns `202 { accepted: true }` immediately. The client observes progress via SSE (`GET /v1/events`).
- **Hub publishing**: All agent events are published to `assistantEventHub`, making them observable via SSE.

Do NOT add new send endpoints. All message ingress should go through `POST /v1/messages` (HTTP) or `session.processMessage()` (IPC).

### Approvals (confirmations, secrets, trust rules)

Approvals are **orthogonal to message sending**. The assistant asks for approval whenever it needs one — this is a separate concern from how a message enters the system.

- **Discovery**: Clients discover pending approvals via SSE events (`confirmation_request`, `secret_request`) which include a `requestId`.
- **Resolution**: Clients respond via standalone endpoints keyed by `requestId`:
  - `POST /v1/confirm` — `{ requestId, decision: "allow" | "deny" }`
  - `POST /v1/secret` — `{ requestId, value, delivery }`
  - `POST /v1/trust-rules` — `{ requestId, pattern, scope }`
- **Tracking**: The `pending-interactions` tracker (`assistant/src/runtime/pending-interactions.ts`) maps `requestId → session`. Use `register()` to track, `resolve()` to consume, `getByConversation()` to query.

Do NOT couple approval handling to message sending. Do NOT add run/status tracking to the send path.

### Channel approvals (Telegram, SMS)

Channel approval flows use `requestId` (not `runId`) as the primary identifier:
- Telegram callback buttons encode `apr:<requestId>:<action>` in `callback_data`.
- Guardian approval records in `channelGuardianApprovalRequests` link via `requestId`.
- The conversational approval engine classifies user intent and resolves via `session.handleConfirmationResponse(requestId, decision)`.

### What NOT to do

- Do NOT use `RunOrchestrator` or `runs-store` — they have been removed.
- Do NOT add `/v1/runs` endpoints — use `/v1/messages` and standalone approval endpoints.
- Do NOT create run status tracking (queued/running/completed/failed) — clients observe progress via SSE events.
- Do NOT use `runId` as an identifier for approval flows — use `requestId`.

## HTTP-First for New Endpoints

New configuration and control endpoints MUST be exposed over HTTP on the runtime server (`assistant/src/runtime/http-server.ts`), not as IPC-only message types. The runtime HTTP server is the canonical API surface — IPC is a legacy transport being phased out.

Existing IPC-only handlers should be migrated to HTTP when touched. The pattern: extract business logic into a shared function, add an HTTP route handler in `assistant/src/runtime/routes/`, keep the IPC handler as a thin wrapper that calls the same logic.

When writing skills that need to call daemon configuration endpoints, use `curl` with the runtime HTTP API (JWT-authenticated via `Authorization: Bearer <jwt>`) rather than describing IPC socket protocol details. The assistant already knows how to use `curl`.

## Error Handling Conventions

Use the right error signaling mechanism for the situation. The codebase has three patterns — pick the one that matches the failure mode:

### 1. Throw for programming errors and unrecoverable failures

Throw an exception (using the error hierarchy from `util/errors.ts`) when:
- A precondition or invariant is violated (indicates a bug in the caller).
- The failure is unrecoverable and the caller cannot meaningfully continue.
- An external dependency is completely unavailable and there is no fallback.

Use the existing `VellumError` hierarchy (`ToolError`, `ConfigError`, `ProviderError`, etc.) rather than bare `Error`. This ensures structured error codes propagate to logging and monitoring.

```typescript
// Good: typed error for a precondition violation
throw new ConfigError('Missing required provider configuration');

// Good: subagent manager throws when depth limit is exceeded
throw new AssistantError('Cannot spawn subagent: parent is itself a subagent', ErrorCode.DAEMON_ERROR);
```

### 2. Result objects for operations that can fail in expected ways

Return a discriminated union or result object when:
- The caller is expected to handle both success and failure paths.
- The failure is a normal operational outcome, not a bug (e.g., "file not found", "path out of bounds", "ambiguous match").

The codebase uses two result patterns — both are acceptable:

**Discriminated union with `ok` flag** (preferred for new code):
```typescript
type EditResult =
  | { ok: true; updatedContent: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; matchCount: number };
```

**Content + error flag** (used by tool execution):
```typescript
interface ToolExecutionResult {
  content: string;
  isError: boolean;
}
```

Existing examples: `EditEngineResult` in `edit-engine.ts`, `PathResult` in `path-policy.ts`, `ToolExecutionResult` in `tools/types.ts`, `MemoryRecallResult` in `memory/retriever.ts`.

### 3. Never return null/undefined to indicate failure

Do not use `null` or `undefined` as a failure signal. When a function can legitimately fail, use a result object (pattern 2 above) so the caller can distinguish between "no result" and "operation failed, here's why."

Returning `undefined` is acceptable only for **lookup functions** where "not found" is a normal query result rather than a failure — e.g., `Map.get()`, `getState(id): State | undefined`. In these cases, `undefined` means "this entity does not exist," not "something went wrong."

### Where each pattern is used

| Module | Pattern | Rationale |
|---|---|---|
| Agent loop (`agent/loop.ts`) | Throws + catch-and-emit | Unrecoverable provider errors break the loop; expected errors (abort, tool-use limits) are caught and emitted as events |
| Tool executor (`tools/executor.ts`) | Result object (`ToolExecutionResult`) | Tool failures are expected operational outcomes — permission denied, unknown tool, sandbox violations. Never throws to callers |
| Memory retriever (`memory/retriever.ts`) | Result object (`MemoryRecallResult`) with degraded/reason fields | Graceful degradation — embedding failures, search failures degrade quality without crashing |
| Filesystem tools (`path-policy.ts`, `edit-engine.ts`) | Discriminated union (`{ ok, reason }`) | Validation outcomes that the caller must handle (out of bounds, not found, ambiguous) |
| Subagent manager (`subagent/manager.ts`) | Throws for precondition violations, string literal unions for expected outcomes | Depth limit exceeded is a bug; `sendMessage` returns `'not_found' | 'terminal' | 'queue_full'` as expected states |

## Notification Pipeline

All notification producers **MUST** go through `emitNotificationSignal()` in `notifications/emit-signal.ts`. Do not bypass the pipeline by broadcasting IPC events directly -- the pipeline handles event persistence, deduplication, decision routing, and delivery audit.

When a notification flow creates a server-side conversation (e.g. guardian question threads, task run threads), the conversation and initial message **MUST** be persisted before the IPC thread-created event is emitted. This ensures the macOS/iOS client can immediately fetch the conversation contents when it receives the event.

## Guardian Verification Invariant

Guardian verification consumption must be identity-bound to the expected recipient identity. Every outbound verification session stores the expected identity (phone E.164, Telegram user/chat ID), and the consume path rejects attempts where the responding actor's identity does not match.

Conversational guardian verification control-plane invocation is guardian-only. Non-guardian and unverified-channel actors cannot invoke guardian verification endpoints (`/v1/integrations/guardian/*`) conversationally via tools. Enforcement is a deterministic gate in the tool execution layer (`assistant/src/tools/executor.ts`) using actor-role context — only `guardian` and `undefined` (desktop/trusted) actor roles pass. The policy module is at `assistant/src/tools/guardian-control-plane-policy.ts`.

## Memory Provenance Invariant

All memory extraction and retrieval decisions must consider actor-role provenance. Untrusted actors (non-guardian, unverified_channel) must not trigger profile extraction or receive memory recall/conflict disclosures. This invariant is enforced in `indexer.ts` (write gate) and `session-memory.ts` (read gate).

## Guardian Privilege Isolation Invariant

Untrusted actors (`non-guardian`, `unverified_channel`) must never receive privileged host/tool capabilities or privileged conversation context directly.

- Tool execution gate: untrusted actors cannot execute host-target tools or side-effect tools in-band. These actions require guardian-mediated approval flow. Enforcement lives in `assistant/src/tools/tool-approval-handler.ts`.
- History view gate: when loading session history for untrusted actors, only untrusted-provenance messages are included and compacted summaries are suppressed. This prevents replay of guardian-era context after trust downgrades. Enforcement lives in `assistant/src/daemon/session-lifecycle.ts` and actor-scoped reload wiring in `assistant/src/daemon/session.ts`.

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
