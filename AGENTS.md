# Vellum Assistant — Agent Instructions

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `assistant/` — Main backend service (Bun + TypeScript)
- `gateway/` — Telegram webhook gateway (Bun + TypeScript)
- `clients/` — Client apps (macOS/iOS/etc). See `clients/AGENTS.md` and platform docs like `clients/macos/CLAUDE.md`.
- `scripts/` — Utility scripts
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`)

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

These are the most commonly used slash commands defined in `.claude/commands/`:

| Command | What it does |
|---|---|
| `/work` | Pick one task from `.private/TODO.md` (or a user-provided task), implement it, open a PR, squash-merge it, and update tracking files. |
| `/do <description>` | Implement a described change in an isolated worktree, ship it to main via a squash-merged PR, and clean up. The PR body includes the original prompt for traceability. |
| `/safe-do <description>` | Like `/do` but creates a PR without auto-merging — pauses for human review. Keeps the worktree in place for addressing feedback. The PR body includes the original prompt for traceability. |
| `/swarm [workers] [max-tasks] [--namespace NAME]` | Process `.private/TODO.md` in parallel — one worktree per agent, auto-merge PRs (auto-assigned to the current user), respawn agents until the list is empty. Uses `--namespace` to prefix branch names and avoid collisions with other parallel swarms (auto-generates a random 4-char hex if omitted). When `--namespace` is explicitly provided, only TODO items prefixed with `[<namespace>]` are processed; when auto-generated, all items are processed. |
| `/blitz <feature>` | End-to-end feature delivery: plan, create GitHub issues on a project board, swarm-execute in parallel, then run a recursive sweep loop (check reviews, swarm to address feedback, repeat) until all PRs — including transitive feedback PRs — are fully reviewed. Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. |
| `/safe-blitz <feature>` | Like `/blitz` but merges milestone PRs into a feature branch instead of main, with per-milestone direct-push feedback loops (push fixes to milestone branch, re-request reviews, repeat until clean or 3 cycles) and a final sweep before opening a PR for manual review. Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. Supports `--auto`, `--workers N`, `--skip-plan`, `--branch NAME`. |
| `/safe-blitz-done [PR\|branch]` | Finalize a safe-blitz — squash-merge the feature branch PR into main, set the project issue to Done, close the issue, and clean up locally. Auto-detects from current branch, open `feature/*` PRs, or project board. |
| `/mainline [title]` | Ship the current uncommitted changes to main via a squash-merged PR. The PR body includes the original prompt (if provided) for traceability. |
| `/ship-and-merge [title]` | Create a PR, wait for Codex and Devin reviews, fix valid feedback (up to 3 rounds), and squash-merge once approved. The PR body includes the original prompt (if provided) for traceability. |
| `/brainstorm` | Read through the codebase and `.private/TODO.md`, generate a prioritized list of improvements, and update the TODO after user approval. |
| `/check-reviews [--namespace NAME]` | Check every PR in `.private/UNREVIEWED_PRS.md` for Codex and Devin reviews; add feedback items to TODO and remove fully-reviewed PRs. When `--namespace` is provided, only PRs whose head branch starts with `swarm/<namespace>/` are processed, and TODO items are prefixed with `[<namespace>]`. When omitted, all PRs are processed, but TODO items are still namespaced if the PR's branch matches `swarm/<NAME>/...` (inferred from the branch name). |
| `/execute-plan <plan-file>` | Execute a multi-PR rollout plan from `.private/plans/` sequentially — implement, validate, and mainline each PR in order. The PR body includes the full plan content for traceability. |
| `/safe-execute-plan <file>` | Start a plan from `.private/plans/` — implements the first PR, creates it (without merging), and stops to wait for human review. The PR body includes the full plan content for traceability. |
| `/safe-check-review [file]` | Check the active plan PR for review feedback from codex/devin/humans. Addresses requested changes, waits if reviews are pending. |
| `/resume-plan [file]` | Merge the current plan PR, implement the next one, create it, and stop again. Repeats until the plan is complete. The PR body includes the full plan content for traceability. |

| `/update` | Pull latest from main, restart the backend daemon, verify gateway health (fail fast on startup failure), rebuild/launch the macOS app, and print a startup summary. |


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

When writing skills that need to call daemon configuration endpoints, use `curl` with the runtime HTTP API (bearer-authenticated via `~/.vellum/http-token`) rather than describing IPC socket protocol details. The assistant already knows how to use `curl`.

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

## Tooling Direction

Do not add new tool registrations using the `class ____Tool implements Tool {` pattern.

Prefer skills in `assistant/skills/vellum-skills/` that teach the model how to use CLI tools directly.

Keep the system prompt as minimal as possible. Avoid adding instructions about how to use tools; only document what tools exist when they are basic, primitive, and universally useful. Prefer CLI programs that the assistant can progressively learn to use via `--help`.

## Migration Guidance

When touching existing tool-based flows, migrate behavior toward skill-driven CLI usage instead of adding new registered tools.

Reasoning: every registered tool increases model context overhead, while the model can usually learn CLI usage from skills on demand and install missing CLI dependencies when needed.
