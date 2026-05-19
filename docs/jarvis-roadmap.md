# JARVIS Roadmap

> Living document. Every meaningful step ships an update at the bottom in the
> **Progress Log**. Old entries are never rewritten — only superseded by new
> entries.

## North star

A locally-trusted assistant that:

1. **Perceives** what is happening on the user's machine continuously.
2. **Judges** what is worth remembering, surfacing, or acting on.
3. **Acts** through narrow, audited, permissioned host capabilities.
4. **Speaks** at human cadence with full context awareness.
5. **Remembers** people, projects, and preferences over time.

Differentiator vs. an "open Claw"-style demo: every host capability is scoped,
default-off, approval-gated, and audited. Security is the moat, not an
afterthought.

## Capability gap analysis

| Capability | Today | Target |
|---|---|---|
| Ambient perception (screen, audio, app, editor) | Nothing continuous | Local low-cost stream, structured signals, on-device privacy gate |
| Local interpreter (cheap brain) | None | Skill-isolated process emitting `perception.*` events |
| Signal bus / relevance gate | `assistantEventHub` exists | Extended with perception event family + relevance scoring |
| Proactive trigger | `wakeAgentForOpportunity` exists for bulletins | Hooked to perception signals with interruption budget |
| Action reliability | Host proxy paths exist | Standard wrapper: precondition → capture → do → verify → rollback |
| Personal knowledge layer | Qdrant + db memory | Entities, episodes, learned preferences |
| Multi-tier model orchestration | Call-site profiles exist | Perception / reflex / main / deliberation tiers populated |
| Voice fusion | Live voice in progress | Perception context injected into voice session |
| Security: capabilities, approvals, audit | Trust rules + CES exist | Per-capability default-off + ephemeral grants + audit on every host action |

## Architecture target

```
[Eyes/Ears on device]  ->  [Local perception model]  ->  [Signal bus]
                                                            |
                                              [Relevance + privacy gate]
                                                            |
                              +-----------------------------+-----------------------------+
                              |                             |                             |
                       [Memory writer]            [Proactive trigger]           [On-demand agent]
                                                            |                             |
                                                            +--------------+--------------+
                                                                           |
                                                              [Policy / approval gate]
                                                                           |
                                                                  [Host proxy tools]
                                                                           |
                                                              [Verification + rollback]
```

Sensitive data never leaves the device unredacted. Only **structured events**
cross the daemon boundary; raw frames stay in the perception process's local
ring buffer and are dropped on TTL.

## Phases

Phases are ordered by leverage, not by ease. Each one has a vertical-slice
exit criterion that proves the spine works end-to-end before we widen it.

### Phase 1 — Perception spine (vertical slice)
Goal: prove the full loop with the minimum useful set of signals.

**Exit criterion:** ask the assistant "what was I working on five minutes
ago?" and get a correct answer derived from perception events, not chat
history.

Scope:
- Event contract in `assistant/src/perception/perception-event.ts`.
- Daemon-side `ContextBuffer` ring (in-memory, TTL'd) subscribed to
  `perception.*` events on `assistantEventHub`.
- `getRecentContext()` tool exposed to the main agent.
- Tauri client emits two signals: active app + window title (no screenshots
  this round).
- New skill `skills/perception/` (process) that consumes Tauri pushes and
  republishes typed events via the existing `host.events.publish` IPC.
- Feature flag `perception` in the assistant feature flag registry, default
  off.
- Blocklist enforced at the source (Tauri) before any signal crosses IPC.

Out of scope for this phase: screenshots, OCR, audio context, editor
context, proactive triggers, knowledge graph. Those land in later phases.

### Phase 2 — Local interpreter
- [x] Cheap LLM call site `llm.callSites.perception` resolved through existing
  resolver.
- [x] Frame → event extractor (e.g. `task_detected`, `meeting_started`,
  `code_edited`).
- [x] PII redaction before publish.

### Phase 3 — Relevance + proactive trigger
- [x] Relevance scorer (tiny model) classifies events into ignore /
  remember / maybe-act / act-now.
- [x] `act-now` hooks into `wakeAgentForOpportunity` (the same path
  `UPDATES.md` already uses).
- [x] Per-hour interruption budget; high-urgency override.

### Phase 4 — Execution reliability wrapper
- `assistant/src/actions/run-action.ts` standard wrapper.
- HUD status strip fed from action lifecycle events.
- Audit log entry per action.

### Phase 5 — Personal knowledge layer
- Workspace migration adds entity / episode tables.
- Writers in memory module, readers exposed as agent tools.
- Implicit preference learning.

### Phase 6 — Voice fusion
- Perception context injected as system input on the live-voice session.
- Voice can hand off mid-utterance to the action wrapper.

### Phase 7 — Multi-tier model orchestration polish
- [x] Populate perception / reflex / deliberation tiers explicitly.
- [x] Document tier responsibilities and expose them in config API responses.

### Phase 8 — Multi-device handoff
- [x] Single coherent session across desktop, browser extension, mobile.
  - Shared default handoff key unifies local first-party interfaces.
  - Client wiring now explicitly adopts/restores this key in local desktop/HUD
    send paths and pre-send normalization.

### Phase 9 — Continuous security hardening
- [x] Capability declarations, ephemeral grants, audit rotation, redaction
  guard tests. Runs alongside every phase, not last.
  - Added guard coverage around handoff key scoping and non-local isolation.
  - Expanded perception redaction guards for token/account-id patterns in
    both emitted events and proactive hint paths.

### Phase 10 — Jarvis vertical-slice MVPs (in flight)

Three coordinated MVPs landing in parallel. Each phase ships behind a
default-off feature flag with its own migration set and guard tests.

#### Phase 10A — Autonomous execution engine

- [x] Migration 241: `plans`, `plan_steps`, `plan_step_runs` (shape mirrors
  `schedule_jobs/_runs` so the crash-recovery template translates).
- [x] Store API at `assistant/src/plans/plan-store.ts` — idempotent on
  `(plan_id, step.order, attempt)`.
- [x] Runner at `assistant/src/plans/run-plan.ts` — stepwise dispatcher,
  each step wrapped with `runAction` for uniform audit + lifecycle, plus
  `plan_lifecycle` + `plan_step_lifecycle` client broadcasts via
  `assistant/src/daemon/message-types/plans.ts`.
- [x] Crash recovery at `assistant/src/plans/recovery.ts`; called from
  `assistant/src/daemon/lifecycle.ts` after schedule recovery, before the
  main agent loop boots.
- [x] HTTP/IPC routes at `assistant/src/runtime/routes/plan-routes.ts`:
  `GET /v1/plans`, `GET /v1/plans/:id`, `POST /v1/plans/:id/cancel`.
- [x] Feature flag `autonomous-execution` (default off) +
  `skills/plans/SKILL.md` + `skills/plans/scripts/plan-control.ts`.

#### Phase 10B — Memory maturation

- [x] Migration 242 — `evidence_count` / `provenance_json` /
  `last_reinforced_at` on `pkb_entities`; counter columns
  (`evidence_count`, `positive_count`, `negative_count`,
  `last_reinforced_at`, `last_contradicted_at`) on `pkb_preferences`;
  `idempotency_key` partial-unique on `pkb_episodes`.
- [x] Store API rewrite: counter-weighted entity confidence, signed
  preference merges, idempotent episode writes, `scorePkb*` helpers.
- [x] Hourly `pkb-decay` worker + post-turn `preference-feedback`
  observer + new `preferenceFeedback` LLM call-site (workspace
  migration 073).
- [x] `personal-knowledge-context.ts` switched to scoring-based
  selection; feature flag `memory-maturation`.

#### Phase 10C — Multimodal perception

- [x] Migration 243 — `perception_consent_grants` table backs the
  per-conversation gate without inventing a new approval primitive.
- [x] `screen_snapshot` + `audio_excerpt` payload schemas in
  `assistant/src/perception/perception-event.ts`; defense-in-depth
  sanitizer extension in `perception-routes.ts`.
- [x] Live-voice `stt_final` publishes `audio_excerpt`; macOS
  `WatchSession.swift` publishes `screen_snapshot` alongside the legacy
  `watch_observation` path.
- [x] Consent flow wired through the new `consent-grants.ts` store; the
  daemon reuses the existing `confirmation_request` → `POST /v1/confirm`
  (`allow_conversation`) path to populate it. Routes reject with
  `consent_required` when missing.
- [x] Feature flags `perception-screen-snapshot` +
  `perception-audio-excerpt`, both default off. Tauri Rust screen
  capture explicitly deferred to MVP+1.

## Phase 1 work plan (active)

Concrete tasks, in order. Status icons: `[ ]` pending, `[~]` in flight,
`[x]` done.

- [x] Roadmap doc (this file) + progress log scaffold.
- [x] Draft typed perception event contract
  (`assistant/src/perception/perception-event.ts`).
- [x] Add `ContextBuffer` ring with TTL and `recent({ window })` query.
- [x] Wire `ContextBuffer` to subscribe to `perception.*` on
  `assistantEventHub` (`attach()` method).
- [x] Add `perception` flag to
  `meta/feature-flags/feature-flag-registry.json` (scope: assistant,
  default off) + sync to bundled copies.
- [x] Add startup module (`perception/startup.ts`) that creates the
  singleton when the flag is on; safe no-op otherwise.
- [x] Tests: ingest happy path + ignore non-perception + drop malformed
  + capacity eviction + TTL expiry + `windowMs`/`limit`/`kind` filters
  + hub attach/detach idempotency.
- [x] Call `startPerception()` from the daemon lifecycle startup sequence.
- [x] Add `GET /v1/perception/recent` shared route that proxies to
  `getPerceptionBuffer().recent(...)` and returns disabled/empty when
  the flag is off or startup has not attached the buffer.
- [x] Add `skills/perception/` scaffold and bundled
  `scripts/recent-context.ts` wrapper around the route. No new non-skill
  tool registrations — daemon hosts the data, skill hosts the surface.
- [x] Tests: route disabled state + documented query params + invalid
  query rejection.
- [x] Add authenticated `POST /v1/perception/publish` route for client
  producers.
- [x] Tauri: active app + window title sampler, behind blocklist,
  pushing to the daemon publish route.
- [x] Add HTTP smoke test for the Phase 1 vertical slice:
  POST perception event -> GET recent context.
- [x] Update progress log with vertical-slice demo proof.

## Security invariants (do not violate)

1. Every new capability is **declared in the feature flag registry** and
   defaults off.
2. Raw screen / audio frames **never** leave the device, even with the
   flag on. Only structured events cross IPC.
3. **Blocklist is enforced at capture time**, not on publish. If 1Password
   is focused, no signal is captured at all.
4. The perception process must not be able to call host action tools — it
   only publishes events.
5. Every host action goes through the action wrapper (Phase 4) with audit
   log entry, regardless of who requested it.
6. Approval prompts are **ephemeral**, scoped to a task/conversation, and
   logged.

## Open questions

- Do we want perception events persisted to disk at all, or memory-only?
  Initial answer: memory-only ring, plus optional rollups into the memory
  module after relevance scoring. Revisit when Phase 5 lands.
- Where does the perception skill live in Docker mode? It has no role
  there until we add a Docker-mode capture channel. For now, perception
  is **bare-metal only**, gated by an additional runtime check.
- How do we represent "user is in a meeting" vs the meet-join skill's
  own state? Coordinate later; perception will emit a coarse signal and
  defer to meet-join for ground truth.

---

## Progress Log

Newest entries at the top. Every entry includes date, phase, what
shipped, and what's next. Never edit old entries — append new ones.

### 2026-05-17 — Phase 10C landed: Multimodal Perception MVP

- Two new perception event kinds added to
  `assistant/src/perception/perception-event.ts`:
  - `screen_snapshot` — bundle/app id + window title + redacted, truncated
    OCR/AX text (≤2048 chars) + `captureMethod: 'ax' | 'ocr'` + confidence
    in `[0, 1]`. Each payload also carries the producer's
    `conversationId` so the consent gate is unambiguous.
  - `audio_excerpt` — session/turn ids + redacted, truncated STT
    transcript (≤1024 chars) + optional BCP-47 language tag + confidence.
    Also carries `conversationId`.
  Both kinds were added to the discriminated union; TypeScript's
  exhaustive `switch` checks immediately surfaced every downstream
  consumer that had to update.
- Defense-in-depth sanitizer extended in
  `assistant/src/runtime/routes/perception-routes.ts`: caller-supplied
  text fields for both kinds are scrubbed via `sanitizeText` /
  `sanitizeOptional` before they enter the hub. Guard tests assert
  emails, secrets, and URLs are redacted.
- Per-conversation consent flow lands as
  `assistant/src/perception/consent-grants.ts`:
  - `hasActivePerceptionConsent`, `getActivePerceptionConsent`,
    `recordPerceptionConsentGrant`, `revokePerceptionConsentGrant`,
    `listPerceptionConsentGrantsForConversation`.
  - Idempotent on `(scope_id, conversation_id, event_kind)`; re-granting
    clears prior revocation, expiry is honoured, revocation returns
    `active` / `already_revoked` / `not_found`.
  - The publish route rejects `screen_snapshot` / `audio_excerpt` with
    `{ accepted: false, reason: "consent_required" }` when no live grant
    exists. We reuse the existing `confirmation_request` →
    `POST /v1/confirm` (`selectedScope: "conversation"`) flow to issue
    grants — no new approval primitive.
- Producers wired:
  - `assistant/src/live-voice/live-voice-session.ts` publishes
    `perception.audio_excerpt` in the `final` branch of
    `handleTranscriberEvent` once `perception` + `perception-audio-excerpt`
    are on AND a consent grant is active. Best-effort: failures here are
    logged at `warn` and never block the live-voice session.
  - `clients/macos/vellum-assistant/Ambient/WatchSession.swift` POSTs a
    `screen_snapshot` perception event alongside the legacy
    `watch_observation` path. Truncates OCR text to the schema's 2048-char
    budget, uses `ISO8601DateFormatter` for `ts`, and reuses the existing
    `GatewayHTTPClient` transport via a new
    `ComputerUseClient.sendScreenSnapshotPerception` method.
- Feature flags `perception-screen-snapshot` and
  `perception-audio-excerpt` in the registry, both `defaultEnabled: false`.
  The existing `perception` master switch remains the top-level gate.
- Tests:
  - `assistant/src/perception/perception-event.test.ts` — schema
    happy/sad paths for both new kinds, including missing `conversationId`,
    oversize text, and out-of-range confidence.
  - `assistant/src/perception/consent-grants.test.ts` — grant lifecycle
    (record / revoke / re-grant), expiry, scoping by `(conversationId,
    eventKind)`.
  - `assistant/src/runtime/routes/perception-routes.test.ts` extended
    with redaction guards for both kinds, `consent_required` rejection
    paths, and length-cap rejections.
  - `assistant/src/live-voice/__tests__/live-voice-stt.test.ts` extended
    with publish-on-final tests for flag-on+consent-on / flag-on+no-consent
    / flag-off paths.
- Out of scope (explicitly deferred): Tauri Rust screen capture, OS-level
  `NSScreenCaptureUsageDescription` Info.plist additions, and any UI for
  managing consent grants. The plan callout — "Tauri Rust capture deferred
  to MVP+1" — is the canonical reference.

### 2026-05-17 — Phase 10B landed: Memory Maturation MVP

- PKB store API hardened around real-use signal:
  - `upsertPkbEntity` now keeps an `evidence_count`, refreshes
    `last_reinforced_at`, appends provenance (capped at 20 entries) and
    replaces the old `Math.max(confidence, incoming)` merge with a
    counter-weighted mean `(evidence*confidence + incoming) / (evidence+1)`.
  - `upsertPkbPreference` takes a `signal: 'positive' | 'negative'` and
    derives confidence from a Laplace-smoothed beta mean
    `positive / (positive + negative + 1)`. Contradictory signals overwrite
    the stored value while keeping the historical counters.
  - `recordPkbEpisode` accepts an optional `idempotencyKey` and short-circuits
    when one is already on file; the perception writer passes
    `${sourceEventId}:${interpreted.kind}` so retries no longer double-write.
  - New `scorePkbEntities` / `scorePkbPreferences` helpers combine confidence,
    decay-anchored recency, and `log1p(evidence_count)` so high-decay items
    drop out of context naturally.
- Hourly decay worker `assistant/src/memory/pkb-decay.ts`:
  - Exponential half-life applied to confidence (`0.5 ** (Δdays / halfLife)`).
  - Half-lives default to 30 days for entities and 45 days for preferences,
    floor at `0.05` so we don't asymptotically chase zero forever.
  - Registered as a new `pkb_decay` `MemoryJobType` and scheduled from
    `maybeEnqueueGraphMaintenanceJobs` only when `memory-maturation` is on.
- Post-turn preference-feedback observer at
  `assistant/src/agent/preference-feedback.ts`:
  - Short-circuits when `memory-maturation` is disabled — safe to call on every
    turn regardless of flag state.
  - Calls the new `preferenceFeedback` LLM call-site via the standard
    provider abstraction, then routes `reinforced` / `contradicted` /
    `inferred` decisions into `upsertPkbPreference` with the right signal.
  - Judgement is model-mediated per the "Assistant-Driven Judgement" rule.
- New `preferenceFeedback` LLM call-site declared in
  `assistant/src/config/schemas/llm.ts` and seeded with cost-optimised
  defaults by workspace migration `073-seed-preference-feedback-callsite.ts`.
- `personal-knowledge-context.ts` switches to scoring-based entity / preference
  selection when `memory-maturation` is enabled; the legacy recency-only path
  remains as the fallback.
- Feature flag `memory-maturation` is added to the registry (default off);
  the store-API changes ship unconditionally (additive, backwards-compatible).
- Tests:
  - `assistant/src/memory/pkb-decay.test.ts` — half-life math, floor clamp,
    skip-below-floor, no-op on empty DB.
  - `assistant/src/agent/preference-feedback.test.ts` — flag short-circuit,
    reinforce, contradict, infer-new-key, malformed response, missing provider.
  - `assistant/src/memory/personal-knowledge-store.test.ts` — extended with
    idempotency, counter-merge, provenance capping, and scoring.

Next: 10C (multimodal perception) lands the `screen_snapshot` / `audio_excerpt`
payloads on top of the existing `perception_consent_grants` table.

### 2026-05-17 — Phase 10A landed: Autonomous Execution Engine MVP

- New durable plan storage at `assistant/src/plans/`:
  - `plan-store.ts` — CRUD over `plans` / `plan_steps` / `plan_step_runs`,
    idempotent on `(plan_id, step.order, attempt)`.
  - `run-plan.ts` — stepwise driver; each step wrapped with `runAction` so
    audit and lifecycle stay uniform with one-shot host actions. Broadcasts
    `plan_lifecycle` + `plan_step_lifecycle` messages through new
    `assistant/src/daemon/message-types/plans.ts`.
  - `recovery.ts` — `recoverStalePlans()` patterned on
    `recoverStaleSchedules`. Called from `daemon/lifecycle.ts` after
    schedule recovery, before the main agent loop boots.
- Migration `241-plan-execution-tables.ts` adds the three tables;
  registered in `db-init.ts` migration steps + `migrations/index.ts`.
- Drizzle schema in `assistant/src/memory/schema/plans.ts`.
- Read + cancel surface:
  - `assistant/src/runtime/routes/plan-routes.ts` exposes `GET /v1/plans`,
    `GET /v1/plans/:id`, `POST /v1/plans/:id/cancel`.
  - `skills/plans/SKILL.md` + `scripts/plan-control.ts` give the agent a
    skill-mediated control surface (no new registered tool, per
    `assistant/src/tools/AGENTS.md`).
- Feature flag `autonomous-execution` added to the registry (default off).
- Tests:
  - `assistant/src/__tests__/db-jarvis-vertical-slice-migrations.test.ts`
    — covers all three Phase 10 migrations (241/242/243) + idempotent re-run.
  - `assistant/src/plans/plan-store.test.ts` — CRUD, ordering, attempt
    monotonicity, recovery, terminal-state semantics.
  - `assistant/src/plans/run-plan.test.ts` — happy/sad/throws/cancel paths.
  - `assistant/src/plans/recovery.test.ts` — crash → resume round-trip.
  - `assistant/src/runtime/routes/plan-routes.test.ts` — list/get/cancel.
- Migrations 242 (PKB quality fields) and 243 (perception consent grants)
  also ship in this PR so subsequent phases stack cleanly. Their store-API
  and producer wiring land in 10B / 10C.

### 2026-05-17 — Follow-up hardening: host-proxy lifecycle + tier consumption + debounce

- Phase 4 reliability wrapper normalization expanded:
  - `runAction(...)` now wraps execution in all remaining host proxies:
    - `assistant/src/daemon/host-bash-proxy.ts`
    - `assistant/src/daemon/host-cu-proxy.ts`
    - `assistant/src/daemon/host-file-proxy.ts`
    - `assistant/src/daemon/host-browser-proxy.ts`
  - Each proxy now emits `action_lifecycle` messages (`started`, `executing`,
    `completed` / `failed`) to the conversation stream via
    `broadcastMessage(...)` using `ActionLifecycleMessage`.
  - Added lifecycle emission coverage in proxy tests:
    - `assistant/src/__tests__/host-bash-proxy.test.ts`
    - `assistant/src/__tests__/host-cu-proxy.test.ts`
    - `assistant/src/__tests__/host-file-proxy.test.ts`
    - `assistant/src/__tests__/host-browser-proxy.test.ts`
- Phase 7 tier metadata consumption expanded on Apple shared client:
  - `clients/shared/Network/SettingsClient.swift` now decodes:
    - `tiers: [CallSiteCatalogTier]` on catalog response
    - `tier: String` on each call-site entry.
- Perception hot-path performance improvement:
  - Added rapid duplicate app-focus debounce in
    `assistant/src/perception/interpreter.ts` with configurable
    `debounceMs` (default `2000ms`) keyed by `(appId, windowTitle)`.
  - Added regression test:
    - `assistant/src/perception/interpreter.test.ts`:
      `debounces rapid duplicate app focus signals`.
- Verification:
  - `cd assistant && bun run lint -- --fix`
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/__tests__/host-bash-proxy.test.ts`
  - `cd assistant && bun test src/__tests__/host-cu-proxy.test.ts`
  - `cd assistant && bun test src/__tests__/host-file-proxy.test.ts`
  - `cd assistant && bun test src/__tests__/host-browser-proxy.test.ts`
  - `cd assistant && bun test src/perception/interpreter.test.ts`
- Notes:
  - Proxy tests continue to log expected non-fatal
    `tool_invocations`-table warnings in isolated unit environments; this does
    not affect assertion outcomes.

### 2026-05-17 — Full audit: defense-in-depth + dedup of redaction logic

- Audit run (typecheck, lint, targeted + boundary + redaction tests):
  - `bunx tsc --noEmit` clean on assistant and clients/tauri.
  - `bun run lint` clean after autofix + removal of unused
    `findPkbEntities` import in
    `assistant/src/perception/personal-knowledge-writer.ts`.
  - 92 targeted perception / handoff / PKB / call-site tests pass.
  - Boundary + redaction guards (skill-isolation, gateway-only,
    persistence-secret-redaction, secret-prompt-log-hygiene,
    host-proxy-interface, assistant-event-hub) pass when isolated.
    `secret-prompt-log-hygiene` shows test-isolation flakiness only when
    co-run with `host-proxy-interface` — pre-existing, unrelated to this
    work.
- Phase 9 defense-in-depth strengthened:
  - Introduced shared sanitizer
    `assistant/src/perception/sanitization.ts` as the single source of
    truth for redaction patterns (email, URL, phone, secret/token,
    account-id) and length budget.
  - Refactored `perception/interpreter.ts` and `perception/relevance-gate.ts`
    to import the shared sanitizer instead of inlining the regex set.
  - Added defense-in-depth on
    `POST /v1/perception/publish`: incoming payloads are re-sanitized
    server-side per `kind` before reaching the event hub / ContextBuffer,
    so a buggy/compromised producer cannot leak raw secrets past the
    daemon trust boundary.
  - New guard test:
    `perception routes > publish route redacts sensitive strings as
    defense-in-depth` in
    `assistant/src/runtime/routes/perception-routes.test.ts`.
- Known open items surfaced by the audit (deferred, not regressions):
  - Phase 4 invariant is only adopted by `host-app-control-proxy`; other
    host proxies (`host-bash`, `host-cu`, `host-file`, `host-browser`)
    still bypass `runAction`. Should be normalized via a follow-up phase.
  - Tier metadata on `/v1/llm/call-sites` is producer-only; Swift
    `CallSiteCatalogResponse` does not yet decode `tiers` / `tier`.
  - `assistantEventHub.publish` fans out subscribers sequentially.
    Switching to bounded parallel fanout would reduce perception ingest
    latency once volume grows.
  - PKB entity search uses `LIKE %x%` over `aliases_json`; would benefit
    from a normalized alias table or FTS index when entity count grows.

### 2026-05-17 — Phase 9 complete: redaction guard expansion

- Hardened perception redaction logic to cover additional sensitive shapes:
  - token/secret/api-key/password-like values
  - account-id-like identifiers (`account-...`, `user_...`, `org-...`, etc.)
  - existing email/URL/phone protections remain intact.
- Applied the expanded redaction to:
  - interpreted perception emission sanitization:
    `assistant/src/perception/interpreter.ts`
  - relevance reason normalization + proactive wake hint payload formatting:
    `assistant/src/perception/relevance-gate.ts`
- Added guard tests to prevent regression:
  - `assistant/src/perception/interpreter.test.ts`
    - asserts token/account-id redaction in emitted `task_detected` fields.
  - `assistant/src/perception/relevance-gate.test.ts`
    - asserts sensitive strings are redacted in both classifier reason and
      act-now wake hints.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/perception/interpreter.test.ts src/perception/relevance-gate.test.ts`
- Next: continue ongoing security maintenance via normal PR hygiene (new
  capability surfaces must include equivalent redaction + guard tests).

### 2026-05-17 — Phase 8 complete: explicit handoff-key client wiring

- Extended cross-interface handoff validation:
  - `assistant/src/__tests__/send-endpoint-busy.test.ts` now verifies that
    local first-party interfaces (`macos`, `ios`, `web`, `chrome-extension`,
    `tauri`) converge on a single default handoff conversation when
    `conversationKey` is omitted.
- Added explicit local handoff constants/helpers in shared client code:
  - `clients/shared/Network/ConversationHandoff.swift`
  - `normalizeConversationKey(...)` now defaults blank/missing keys to
    `default:vellum:handoff`.
- Wired handoff-key restore/adoption in desktop client setup and send paths:
  - `clients/macos/vellum-assistant/App/AppDelegate+ConnectionSetup.swift`
    now binds local connection ownership to the shared handoff key.
  - `clients/shared/Network/MessageClient.swift` and
    `clients/shared/Network/BtwClient.swift` normalize empty keys to the
    shared handoff key before POST.
  - `clients/tauri/src/services/gateway-client.ts` now explicitly includes
    `conversationKey: "default:vellum:handoff"` when none is provided.
- Added regression coverage in macOS client tests:
  - `clients/macos/vellum-assistantTests/MessageClientTimezoneTests.swift`
    now verifies fallback to `ConversationHandoff.defaultLocalConversationKey`.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/__tests__/send-endpoint-busy.test.ts`
  - `cd clients && swift test --filter MessageClientTimezoneTests`
  - `cd clients/tauri && bunx tsc --noEmit`
- Next: continue Phase 9 hardening in parallel (capability boundary and
  redaction guard expansion).

### 2026-05-17 — Phase 7 complete + Phase 8/9 handoff hardening

- Added explicit call-site model tiers (`perception`, `reflex`, `deliberation`)
  and exported tier metadata for clients:
  - `assistant/src/config/schemas/call-site-catalog.ts`
  - `assistant/src/runtime/routes/llm-call-sites-routes.ts`
- Added tests that enforce every call site maps to a declared tier:
  - `assistant/src/__tests__/llm-callsite-catalog.test.ts`
  - `assistant/src/runtime/routes/__tests__/llm-call-sites-routes.test.ts`
- Added shared multi-device default conversation handoff logic for first-party
  local interfaces (`macos`, `ios`, `web`, `chrome-extension`, `tauri`):
  - `assistant/src/runtime/conversation-handoff.ts`
  - wired into `assistant/src/runtime/routes/conversation-routes.ts`
  - wired into live voice fallback mapping in
    `assistant/src/runtime/http-server.ts`
  - mirrored default key in `clients/tauri/src/services/live-voice-client.ts`
- Security hardening coverage:
  - `assistant/src/runtime/__tests__/conversation-handoff.test.ts` verifies
    non-local channel isolation and no CLI merge into shared handoff key.
  - Updated `assistant/src/__tests__/send-endpoint-busy.test.ts` to assert
    shared handoff-key behavior.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/runtime/__tests__/conversation-handoff.test.ts src/runtime/routes/__tests__/llm-call-sites-routes.test.ts src/__tests__/llm-callsite-catalog.test.ts src/__tests__/send-endpoint-busy.test.ts`
- Next in Phase 8: wire explicit handoff-key adoption/restore behavior in iOS
  and browser extension clients, then add cross-interface integration coverage.

### 2026-05-17 — Phase 6 progress: spoken action lifecycle cues

- Wired action lifecycle events through the voice bridge callback surface:
  - `assistant/src/calls/voice-session-bridge.ts`
  - `VoiceTurnCallbacks` now includes `action_lifecycle`, and `startVoiceTurn`
    forwards `action_lifecycle` daemon messages to voice clients.
- Added live-voice lifecycle cue handling:
  - `assistant/src/live-voice/live-voice-session.ts`
  - when an in-flight voice turn receives lifecycle stages
    (`started`/`executing`/`completed`/`failed`/`rollback_*`), the session now:
    - emits short conversational status deltas (e.g. "Working on ..."),
    - feeds the same cue text into TTS buffering for spoken progress updates,
    - dedupes repeated stage announcements per action ID.
- Added targeted tests:
  - `assistant/src/__tests__/voice-session-bridge.test.ts`
    - verifies `action_lifecycle` forwarding to callbacks.
  - `assistant/src/live-voice/__tests__/live-voice-agent-turn.test.ts`
    - verifies lifecycle events become assistant status deltas in live voice.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/live-voice/__tests__/live-voice-agent-turn.test.ts src/__tests__/voice-session-bridge.test.ts`
- Next in Phase 6: add client-visible live-voice status surface plumbing for
  these lifecycle cues (dedicated frame/UI affordance rather than text delta).

### 2026-05-15 — Phase 6 kickoff: live-voice perception fusion

- Wired perception-memory context into live voice turn grounding:
  - `assistant/src/live-voice/live-voice-session.ts` now builds each
    `voiceControlPrompt` as:
    - base live-voice prompt, plus
    - `<perception_memory>...</perception_memory>` when recent PKB context is
      available.
- Added dependency seam for deterministic tests:
  - `LiveVoiceSessionOptions.getPerceptionMemoryContext?: () => string | null`
  - defaults to `buildPerceptionKnowledgeContext()` with safe fallback to
    `null` on any retrieval failure.
- Added test coverage:
  - `assistant/src/live-voice/__tests__/live-voice-agent-turn.test.ts`
    validates prompt injection for a synthetic perception-memory payload.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/live-voice/__tests__/live-voice-agent-turn.test.ts src/perception/personal-knowledge-context.test.ts`
- Next in Phase 6: route live voice action/tool handoffs through richer
  lifecycle-aware feedback so spoken replies can confirm in-progress host
  actions with the same reliability cues as HUD text mode.

### 2026-05-15 — Phase 5 complete: main-agent PKB context injection

- Added a pre-turn perception-memory context formatter:
  - `assistant/src/perception/personal-knowledge-context.ts`
  - renders compact sections from PKB rows (`episodes`, `entities`,
    `preferences`) with bounded per-line length.
- Added PKB listing helper:
  - `listRecentPkbEntities(...)` in
    `assistant/src/memory/personal-knowledge-store.ts`.
- Wired main-agent runtime injection:
  - `assistant/src/daemon/conversation-agent-loop.ts` now builds
    `perceptionMemoryContext` on full-mode trusted turns and threads it into
    all re-injection paths (normal, overflow/compaction, convergence, fallback).
  - `assistant/src/daemon/conversation-runtime-assembly.ts` + plugin types now
    carry `perceptionMemoryContext` as a first-class injection input.
  - `assistant/src/plugins/defaults/injectors.ts` adds
    `perception-memory-context` (order `39`) that emits
    `<perception_memory>...</perception_memory>` after memory-prefix blocks.
- Safety and lifecycle:
  - context is gated with the same trusted-actor/remote-channel logic used by
    memory-v2 static injection.
  - `<perception_memory>` added to compaction strip prefixes so re-assembly does
    not duplicate stale snapshots.
- Added/updated verification:
  - `assistant/src/perception/personal-knowledge-context.test.ts`
  - `assistant/src/__tests__/perception-memory-injector.test.ts`
  - updated `assistant/src/__tests__/injector-chain.test.ts`
  - updated `assistant/src/memory/personal-knowledge-store.test.ts`
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/perception/personal-knowledge-context.test.ts src/perception/personal-knowledge-writer.test.ts src/memory/personal-knowledge-store.test.ts src/__tests__/injector-chain.test.ts src/__tests__/perception-memory-injector.test.ts`
- Next phase (Phase 6): voice fusion — feed this same perception-memory snapshot
  into live voice session grounding so spoken responses inherit current task
  context without waiting for chat turns.

### 2026-05-15 — Phase 5 skill bridge: PKB query script

- Extended the first-party `skills/perception` skill so the main agent can read
  PKB data through a bundled script, not just daemon internals.
- Added `skills/perception/scripts/personal-knowledge.ts`:
  - supports `--mode entities|episodes|preferences`,
  - supports `--query` for entity lookup and optional `--limit`,
  - uses the same injected-auth + local fallback token strategy as
    `recent-context.ts` for local/dev reliability.
- Updated `skills/perception/SKILL.md` to document:
  - the new Phase 5 personal-knowledge read surface,
  - command examples for entities/episodes/preferences,
  - endpoint mapping to `/v1/personal-knowledge/*`.
- Next in Phase 5: consume PKB outputs directly in main-agent planning prompts
  (e.g., short pre-turn memory retrieval policy + prompt context formatting).

### 2026-05-15 — Phase 5 wiring: relevance -> PKB + query routes

- Wired a new perception-side PKB writer:
  - `assistant/src/perception/personal-knowledge-writer.ts`
  - Subscribes to perception events, caches interpreted events
    (`task_detected` / `meeting_started` / `code_edited`), and on
    `relevance_scored` with decision `remember` / `maybe-act` / `act-now`,
    persists:
    - entities (`pkb_entities`) with confidence,
    - episodes (`pkb_episodes`) with salience derived from decision+urgency,
    - lightweight learned preferences (`pkb_preferences`) for repeated patterns.
- Integrated writer into perception lifecycle:
  - `assistant/src/perception/startup.ts` now starts/stops the writer alongside
    `ContextBuffer`, interpreter, and relevance gate.
- Added read surface for agent/query clients:
  - `assistant/src/runtime/routes/personal-knowledge-routes.ts`
  - new endpoints:
    - `GET /v1/personal-knowledge/entities`
    - `GET /v1/personal-knowledge/episodes`
    - `GET /v1/personal-knowledge/preferences`
  - route registration updated in `assistant/src/runtime/routes/index.ts`.
- Added targeted verification coverage:
  - `assistant/src/perception/personal-knowledge-writer.test.ts`
  - `assistant/src/runtime/routes/personal-knowledge-routes.test.ts`
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/perception/personal-knowledge-writer.test.ts src/runtime/routes/personal-knowledge-routes.test.ts src/memory/personal-knowledge-store.test.ts`
- Next in Phase 5: expose these PKB reads through a first-party skill interface
  so the main agent can consume them as explicit memory context in planning.

### 2026-05-15 — Phase 5 kickoff: personal knowledge storage spine

- Added normalized PKB tables (DB migration `240`):
  - `pkb_entities`: canonical entities with aliases/attributes and confidence.
  - `pkb_episodes`: timestamped episodic observations linked to entities.
  - `pkb_preferences`: implicit preference key/value records with confidence.
- Wired migration into startup init path:
  - `assistant/src/memory/migrations/240-pkb-entity-episode-tables.ts`
  - exports + `initializeDb()` migration step list updated.
- Added typed schema exports:
  - `assistant/src/memory/schema/personal-knowledge.ts`
  - re-exported from schema index.
- Added writer/reader memory module:
  - `assistant/src/memory/personal-knowledge-store.ts`
  - `upsertPkbEntity`, `findPkbEntities`, `recordPkbEpisode`,
    `listRecentPkbEpisodes`, `upsertPkbPreference`, `listPkbPreferences`.
- Added unit coverage:
  - `assistant/src/memory/personal-knowledge-store.test.ts`
  - covers entity merge/upsert behavior, alias/canonical lookup, episode
    ordering, and preference upsert semantics.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/memory/personal-knowledge-store.test.ts`
- Next in Phase 5: connect perception/relevance outputs to PKB writers and add
  a small read surface for the main agent to query entities/episodes directly.

### 2026-05-15 — Phase 4 kickoff: action wrapper + lifecycle feed

- Added a reusable execution wrapper:
  - `assistant/src/actions/run-action.ts` introduces a standard action flow with
    lifecycle stages (`started`, `executing`, `completed`, `failed`,
    `rollback_*`) and optional rollback handling.
  - Every wrapped action now writes an audit entry through the existing
    `tool_invocations` store (`toolName: action:<actionName>`), including
    decision, risk level, and duration.
- Added a typed server message for action lifecycle events:
  - `assistant/src/daemon/message-types/actions.ts`
  - integrated into the aggregate daemon protocol union.
- Wired host app-control through the wrapper as the first adopter:
  - `HostAppControlProxy.request(...)` now runs inside `runAction(...)`.
  - Emits `action_lifecycle` messages via `broadcastMessage(...)` so connected
    clients can show progress.
- HUD status strip feed:
  - Tauri `HostProxyClient` now consumes `action_lifecycle` events and maps
    them into status-strip action/error text.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/actions/run-action.test.ts`
  - `cd clients/tauri && bunx tsc --noEmit`
- Next in Phase 4: adopt the wrapper for the other host proxies and add richer
  per-action status badges (not just text) in the HUD strip.

### 2026-05-15 — Phase 3 complete

- Added explicit relevance decision event stream:
  - `perception.relevance_scored` now emits for every interpreted event scored
    by the relevance gate (`ignore` / `remember` / `maybe-act` / `act-now`).
  - Payload includes source event link, urgency, redacted reason, and trigger
    outcome fields (`triggeredWake`, `blockedByBudget`, `wakeConversationId`).
- Relevance gate now emits an auditable canonical decision signal even when no
  proactive wake occurs, so memory writers and other downstream jobs can consume
  one uniform stream.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/perception/interpreter.test.ts src/perception/relevance-gate.test.ts src/runtime/routes/perception-routes.test.ts src/runtime/routes/perception-http-smoke.test.ts`
    (16 passing tests)
- Phase 3 status: **done**. Next work moves to Phase 4 (execution reliability
  wrapper + lifecycle/audit events).

### 2026-05-15 — Phase 3 kickoff: relevance gate + proactive wake wiring

- Added `PerceptionRelevanceGate`
  (`assistant/src/perception/relevance-gate.ts`).
  - Consumes interpreted perception events (`task_detected`,
    `meeting_started`, `code_edited`) from `assistantEventHub`.
  - Uses a tiny LLM classification pass (`callSite: perception`) to map each
    event to one of: `ignore`, `remember`, `maybe-act`, `act-now`.
  - Applies bounded output validation (`zod`) and conservative fallback
    decisions when model output is missing/invalid.
- Wired `act-now` to `wakeAgentForOpportunity` via a background conversation
  bootstrap path (`source: perception_proactive`), matching the same generic
  wake mechanism used by other subsystem opportunities.
- Added per-hour interruption budget enforcement for `act-now`:
  - Stores rolling wake timestamps in memory checkpoints
    (`perception:act-now:hourly-timestamps`).
  - Enforces a default hourly cap for non-high urgency opportunities.
  - Supports high-urgency override while still recording budget state.
  - Rolls back budget consumption if wake invocation fails and cleans up orphan
    background conversations.
- Startup wiring:
  - `startPerception()` now attaches `PerceptionRelevanceGate` alongside
    `ContextBuffer` and `PerceptionInterpreter`.
  - `stopPerception()` detaches the relevance gate for clean shutdown/tests.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/perception/interpreter.test.ts src/perception/relevance-gate.test.ts src/runtime/routes/perception-routes.test.ts src/runtime/routes/perception-http-smoke.test.ts`
    (15 passing tests)
- Next in Phase 3: add an explicit relevance/audit event stream for
  ignore/remember/maybe-act decisions so downstream memory writers can consume
  the same gate outputs.

### 2026-05-15 — Phase 2 complete

- Seeded workspace migration `072-seed-perception-callsite` so the
  perception interpreter reliably uses a cheap, bounded call-site default
  instead of inheriting heavyweight chat defaults.
  - Preserves explicit user-owned `profile`/`provider`/`model` selections.
  - Seeds low-cost defaults (`maxTokens`, low effort, no thinking, bounded
    context window) when unset.
- Added migration regression tests:
  - `assistant/src/__tests__/workspace-migration-072-seed-perception-callsite.test.ts`
- Phase 2 checklist is now fully complete:
  - dedicated `perception` call-site exists and is seeded
  - local interpreter emits structured `task_detected` /
    `meeting_started` / `code_edited` events
  - interpreted payloads are redacted before publish
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/__tests__/workspace-migration-072-seed-perception-callsite.test.ts src/perception/interpreter.test.ts src/runtime/routes/perception-routes.test.ts src/runtime/routes/perception-http-smoke.test.ts`
    (16 passing tests)
- Next: begin Phase 3 (relevance scoring + proactive trigger/budget wiring).

### 2026-05-15 — Phase 2: taxonomy expansion

- Expanded interpreted perception taxonomy beyond generic `task_detected`.
  - Added `meeting_started` and `code_edited` event kinds to the perception
    contract.
  - Kept all interpreted payloads bounded and source-linked with
    `sourceEventId` for auditability.
- Upgraded `PerceptionInterpreter` output contract and prompt to select among:
  `task_detected`, `meeting_started`, and `code_edited`.
  - Added optional structured fields where relevant (`platform`,
    `workspaceHint`, `languageHint`).
  - Preserved confidence gating and defensive redaction on all emitted text.
- Added tests for:
  - meeting classification publish path (`perception.meeting_started`)
  - low-confidence suppression
  - existing task-detected and route smoke coverage remained green.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/perception/context-buffer.test.ts src/perception/interpreter.test.ts src/runtime/routes/perception-routes.test.ts src/runtime/routes/perception-http-smoke.test.ts`
    (22 passing tests)
- Next in Phase 2: fold in lightweight temporal context (previous focus event)
  for better stability and add explicit PII-shape regression fixtures.

### 2026-05-15 — Phase 2 kickoff: local interpreter spine

- Added a dedicated `llm.callSites.perception` call-site so perception
  interpretation can be tuned independently from the main agent profile.
- Introduced `PerceptionInterpreter`
  (`assistant/src/perception/interpreter.ts`).
  - Subscribes to `perception.*` events.
  - Consumes `app_focus_changed` inputs.
  - Calls the configured provider through the new `perception` call-site.
  - Emits interpreted `perception.task_detected` events when confidence is
    high enough.
- Extended the perception contract with `task_detected`.
  - Added payload schema: `label`, `summary`, `confidence`, `sourceEventId`.
  - Kept strict bounds so downstream consumers get typed, bounded data.
- Added defensive redaction in the interpreter before prompt input and before
  emitting interpreted events (emails/URLs/phone-like strings scrubbed).
- Wired interpreter lifecycle into perception startup/shutdown alongside the
  existing `ContextBuffer`.
- Verification:
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/perception/context-buffer.test.ts src/perception/interpreter.test.ts src/runtime/routes/perception-routes.test.ts src/runtime/routes/perception-http-smoke.test.ts`
    (20 passing tests)
- Next in Phase 2: improve extraction taxonomy (`meeting.started`,
  `code.edited`, etc.) and add stronger redaction coverage tests.

### 2026-05-15 — Phase 1 complete: vertical slice proven

- Closed the last Phase 1 gap: recorded end-to-end proof and marked the
  work-plan checklist complete.
- Fixed a startup race that could keep perception disabled even when
  `perception: true` was set in gateway overrides.
  - Root cause: `startPerception()` ran before async
    `initFeatureFlagOverrides()` hydration completed, so the first
    flag read could fall back to registry defaults (`perception=false`).
  - Fix: after background feature-flag init resolves, lifecycle now
    retries `startPerception()` (idempotent + safe no-op when already started).
- Verification:
  - Runtime smoke on a live local assistant:
    - `POST /v1/perception/publish` -> `{"accepted":true}`
    - `bun ./skills/perception/scripts/recent-context.ts --window-ms 300000 --limit 5`
      returned `enabled: true` with the newly published
      `app_focus_changed` event (`appName: "Visual Studio Code"`).
  - `cd assistant && bunx tsc --noEmit`
  - `cd assistant && bun test src/runtime/routes/perception-http-smoke.test.ts src/runtime/routes/perception-routes.test.ts src/perception/context-buffer.test.ts`
    (18 passing tests)
- Phase 1 status: **done**. Next work moves to Phase 2 (local interpreter).

### 2026-05-14 — Voice: xAI streaming TTS wired

- Upgraded the existing `xai` TTS provider from REST-only synthesis to
  live streaming synthesis via `wss://api.x.ai/v1/tts`.
  - Live voice can now use the configured `xai` provider because it
    advertises `supportsStreaming: true`.
  - The streaming path requests 16 kHz PCM when live voice asks for
    `outputFormat: "pcm"`, matching the downstream live audio pipeline.
  - API keys stay server-side in the secure credential store under
    `credential/xai/api_key`; the desktop client never sees the key.
- Verification:
  - `bun test src/tts/__tests__/provider-adapters.test.ts src/tts/__tests__/provider-catalog.test.ts src/tts/__tests__/provider-catalog-consistency.test.ts`
    passes 87 tests.
  - `bunx tsc --noEmit` clean in `assistant/`.
- Next: store an xAI API key, switch `services.tts.provider` to `xai`,
  and run a live voice smoke test with the HUD.

### 2026-05-14 — Phase 1: Tauri active-window producer

- `POST /v1/perception/publish` added.
  - Validates one `PerceptionEvent`.
  - Publishes to `assistantEventHub` only when the perception buffer is
    active.
  - Returns `{ accepted: false, reason: "disabled" }` when the flag is
    off or startup has not attached the buffer.
- Tauri Rust command `active_window_context` added.
  - macOS-only via `osascript` / System Events.
  - Returns `null` for blocked apps before the title crosses into
    JavaScript.
  - Blocks 1Password, Keychain Access, and System Settings/Preferences.
  - Redacts title when it contains sensitive terms like private
    browsing/incognito/password/login/bank/payment/checkout.
- Tauri React service `PerceptionClient` added.
  - Samples every 5 seconds.
  - Dedupes unchanged app/title signatures.
  - Posts structured `app_focus_changed` events to
    `/v1/perception/publish`.
  - Marks a signature as delivered only after the daemon returns
    `accepted: true`, so enabling perception after the HUD is already
    open still sends the current focus state.
  - Best-effort: failures do not affect voice, host proxy, or the HUD.
- Verification:
  - `bunx tsc --noEmit` clean in `assistant/`.
  - `bun test src/runtime/routes/perception-routes.test.ts src/perception/context-buffer.test.ts`
    passes 17 tests, including the enabled publish/readback path.
  - `bun run typecheck` clean in `clients/tauri/`.
  - `bun run lint` clean in `clients/tauri/`.
  - `bun test src/__tests__/gateway-only-guard.test.ts` clean after
    removing a stale Tauri comment that referenced the direct runtime
    port instead of the gateway-fronted URL.
  - `cargo fmt --check` could not run because `cargo` is not installed
    in this environment.
- Next: run the HUD with the `perception` flag enabled and verify the
  end-to-end query: "what was I working on five minutes ago?"

### 2026-05-14 — Phase 1: HTTP vertical-slice smoke

- Added `assistant/src/runtime/routes/perception-http-smoke.test.ts`.
  - Forces the `perception` flag on in test.
  - Starts the real `RuntimeHttpServer` on an ephemeral port.
  - Posts an `app_focus_changed` event to `/v1/perception/publish`.
  - Reads it back from `/v1/perception/recent?limit=1`.
- Verification:
  - `bun test src/runtime/routes/perception-http-smoke.test.ts src/runtime/routes/perception-routes.test.ts src/perception/context-buffer.test.ts`
    passes 18 tests.
  - `bunx tsc --noEmit` clean in `assistant/`.
- Remaining manual smoke: run the Tauri shell with the `perception` flag
  enabled and ask the assistant what the user was working on recently.

### 2026-05-14 — Phase 1: read surface and startup wiring

- Perception now starts from daemon lifecycle startup via
  `startPerception()` and detaches during graceful shutdown via
  `stopPerception()`.
- `GET /v1/perception/recent` added as a shared route
  (`assistant/src/runtime/routes/perception-routes.ts`).
  - Query params: `windowMs`, `limit`, `kind`.
  - Returns `{ enabled: false, entries: [] }` when perception is off or
    not started.
  - Shared route means HTTP clients and IPC callers use the same handler.
- `skills/perception/` added.
  - `SKILL.md` documents activation, security boundaries, and Phase 1
    limits.
  - `scripts/recent-context.ts` wraps the route for skill use.
  - `skills/catalog.json` includes the skill.
- Route tests added:
  `assistant/src/runtime/routes/perception-routes.test.ts`.
- Verification:
  - `bunx tsc --noEmit` clean in `assistant/`.
  - `bun test src/runtime/routes/perception-routes.test.ts src/perception/context-buffer.test.ts`
    passes 14 tests.
- Next: Tauri active-app/window-title sampler plus a publish route for
  producer events. This is the first host-facing piece and must enforce
  blocklist/redaction before emitting.

### 2026-05-14 — Phase 1: daemon-side spine assembled

- `ContextBuffer` ring shipped
  (`assistant/src/perception/context-buffer.ts`).
  - Memory-only, capacity-bounded (default 512), TTL-bounded
    (default 30 min).
  - `attach(hub)` subscribes as a `process`-typed subscriber, ignores
    non-perception events, drops malformed perception payloads with a
    warn log rather than throwing.
  - `recent({ windowMs, limit, kind })` returns most-recent-first.
  - 11 unit tests, all green.
- Feature flag `perception` added to the registry
  (`meta/feature-flags/feature-flag-registry.json`), default off, scope
  `assistant`. Bundled copies synced via
  `meta/feature-flags/sync-bundled-copies.ts`.
- Gate helper `perception/feature-gate.ts` exports `isPerceptionEnabled`
  so every call site reads the flag through one path.
- Startup module `perception/startup.ts` creates the singleton,
  attaches it to `assistantEventHub`, and is a safe no-op when the flag
  is off — matches the daemon-never-blocks-startup rule.
- **Not yet called from `daemon/main.ts`** — that's the next commit so
  the wiring lands once the IPC surface for skills is also in place.
- Decision: per `assistant/src/tools/AGENTS.md`, perception's agent
  surface (`getRecentContext`) will live as a **skill tool**, not a new
  daemon tool registration. The daemon hosts the buffer; a forthcoming
  `skills/perception/` will expose the read-only query through skill
  IPC and forward to `getPerceptionBuffer()`.
- Next: skill scaffold + IPC route, then daemon-main wiring, then the
  Tauri sampler.

### 2026-05-14 — Phase 1: event contract landed

- `assistant/src/perception/perception-event.ts` shipped.
  - Zod-validated discriminated union, `app_focus_changed` payload only.
  - Producers must call `parsePerceptionEvent()` at the trust boundary;
    consumers MUST NOT trust raw input.
  - Event topic uses `perception.<kind>` so subscribers can filter
    without parsing the payload.
- Typecheck clean across the assistant package.
- Next: `ContextBuffer` ring (memory-only, TTL-driven) wired to
  `assistantEventHub` subscriptions on `perception.*`. Then surface
  `getRecentContext` as a tool the main agent can call.

### 2026-05-14 — Phase 1 kickoff

- Roadmap doc created (`docs/jarvis-roadmap.md`).
- Capability gap, target architecture, and 9-phase plan committed.
- Phase 1 vertical-slice scope locked: signals = active app + window
  title only; screenshots / OCR / audio / editor context deferred.
- Security invariants enumerated.
- Next: draft typed perception event contract and land the daemon-side
  `ContextBuffer` so Tauri has a concrete target to publish to.
