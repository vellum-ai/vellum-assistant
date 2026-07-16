# Activation Funnel Telemetry — Runbook + Analytics Handoff

> **Linear:** event emission ticket — gates rollout and dashboard tickets.
> **Funnel version:** `activation_v1_2026_06`
> **LD flag:** `experiment-activation-flow-2026-06-03`
> **Cohort arm tag:** `ab_variant = "variant-a"` (treatment); `control` = the no-rail arm.

This doc is the single executable reference for the activation-rail funnel
telemetry: what it measures, how it flows, the event vocabulary, the dedup
contract, the local smoke-test runbook, the BigQuery verification query, and the
canonical handoff blurb for the dashboard work. It is meant to be runnable by
another engineer without reading the implementation.

---

## 1. Overview — what it measures and how it flows

The activation funnel measures how far a new user gets on their first run of the
**activation rail** (the onboarding experience driven by
`BOOTSTRAP-ACTIVATION-RAIL.md`). It emits five milestone ("funnel") events per
session into the **existing onboarding telemetry substrate** — no new event type,
no new ingest endpoint, no new BigQuery table.

The north-star "≥5 user messages within 24h per LD variant" metric is **not** a
materialized activation event. It is computed downstream by joining the existing
per-user-message `turn` telemetry events (`turn_index` per conversation) to the
platform's `flag_assignment_raw` cohort-assignment table — so a dedicated event
and a custom daemon turn-counting hook are not needed.

Flow, end to end:

1. **Daemon records** an activation event into the SQLite `telemetry_events`
   outbox — the row stores the record-time wire payload, including the
   deterministic activation `daemon_event_id` (§3) — via
   `recordActivationEvent()` in
   `assistant/src/onboarding/onboarding-events-store.ts`:
   - emission is **deterministic, tied to a `ui_show` surface** — there is no
     model-facing tool. The model tags the surface it is already rendering for a
     rail move with an optional `activation_moment` parameter on `ui_show`; the
     daemon captures that tag on the surface's server-side state and records the
     milestone (gated on `isActivationSession`). **Timing is per-moment**
     (`ACTIVATION_MOMENT_EMIT_AT` in `activation-funnel.ts`): most moments record
     when the user **commits** the surface (clicks an action / submits /
     selects) via `handleSurfaceAction()`; the one exception is
     `first_wow_executed`, which records at **render time** in
     `surfaceProxyResolver` — the Run result/`work_result` surface is often
     display-only and may never be committed, so a commit-time emit would never
     fire (and deferring it to a later click would conflate "executed" with
     "interacted"). Show-timing tags are recorded immediately and not stored, so
     the commit path never double-emits. The token→step-name map and the
     show/commit timing both live in
     `assistant/src/telemetry/activation-funnel.ts`;
   - emission is best-effort (wrapped in try/catch) and never blocks or alters
     the surface-action flow;
   - `recordActivationEvent` respects the platform `share_analytics` consent gate
     via `getRawShareAnalytics()`: only a confirmed opt-out (`false`) drops the
     event; an `"unknown"` state (cold cache, no platform session) records and
     lets the flush/ingest gates enforce consent before anything ships.
2. **Reporter flushes** every ~5 min: `usage-telemetry-reporter.ts`
   (`REPORT_INTERVAL_MS = 5 * 60 * 1000`, with a one-time
   `INITIAL_FLUSH_DELAY_MS = 30_000` after startup) POSTs queued onboarding
   rows to `/v1/telemetry/ingest/` as `type: "onboarding"` events — the stored
   record-time payloads as-is — and deletes the rows after a successful upload.
3. **Platform ingests** the onboarding events and writes GCS NDJSON.
4. **BigQuery** exposes them via the external table
   `vellum-ai-prod.telemetry.onboarding_raw`, which already carries the
   `session_id / step_name / step_index / completed_at / funnel_version /
ab_variant` columns. The existing dbt model dedups on `daemon_event_id`
   (earliest-wins).

No platform / dbt / terraform change is required — the activation events ride the
`type: "onboarding"` substrate that already exists end to end.

---

## 2. Event vocabulary

The single source of truth is `assistant/src/telemetry/activation-funnel.ts`
(`ACTIVATION_STEPS`). `funnel_version = "activation_v1_2026_06"`
(`ACTIVATION_FUNNEL_VERSION`). `ab_variant = "variant-a"`
(`ACTIVATION_AB_VARIANT`, the treatment arm).

Each step is recorded when the user commits the `ui_show` surface the model
tagged with the corresponding `activation_moment` token (see §1). The
token→step-name map is the `moment_*` column below.

| step_index | step_name                         | `activation_moment` token | Recorded on commit of                                           |
| ---------- | --------------------------------- | ------------------------- | --------------------------------------------------------------- |
| 1          | `activation_moment_1_complete`    | `moment_1`                | Port-summary card OR no-port intake `choice` surface            |
| 2          | `activation_moment_2_complete`    | `moment_2`                | Propose offer surface (the `ui_show` offer card/choice)         |
| 3          | `activation_moment_3_complete`    | `moment_3`                | task-selection surface                                          |
| 4          | `activation_first_wow_executed`   | `first_wow_executed`      | Run result surface (e.g. `work_result`)                         |
| 5          | `activation_first_wow_interacted` | `first_wow_interacted`    | user clicks an action on the tagged result surface (see §1, §4) |

All five steps are recorded deterministically on surface commit. The north star
(≥5 user messages) is derived downstream from the existing `turn` telemetry, not
a materialized activation event (see §1).

On the wire, each onboarding event also sets `screen = step_name` (to satisfy
the platform's legacy-path validation), and `completed_at` is the ISO-8601
record time.

---

## 3. Dedup contract

Activation rows carry a **deterministic** `daemon_event_id`:

```
daemon_event_id = `${funnel_version}:${session_id}:${step_name}`
```

Built by `buildActivationDaemonEventId()` in
`assistant/src/telemetry/activation-funnel.ts`. The store freezes the id into
the outbox payload **at record time**, keyed on the **funnel version the row was
recorded under**, NOT whatever constant the binary that later flushes it carries.
This keeps the id stable across a version bump so rows queued offline / flushed
after an upgrade still collapse with already-ingested rows from the same session.

A moment that fires more than once (e.g. a model double-emit) therefore lands
with the same `daemon_event_id` and is collapsed downstream by the existing dbt
earliest-wins dedup on `daemon_event_id`. For boolean "moment complete"
semantics, earliest-wins is correct.

**Flush safety:** each outbox row keeps its own random row `id`, and the reporter
acknowledges (deletes) shipped rows by that row id, NOT by `daemon_event_id`. The
deterministic id lives only in the wire payload, so it never affects flush
bookkeeping.

---

## 4. Cohort scoping

Events only emit for conversations explicitly marked as **activation-rail
sessions**:

- The marker lives in the `activation_sessions` table
  (`assistant/src/memory/activation-session-store.ts`,
  `markActivationSession` / `isActivationSession`).
- It is set in `assistant/src/prompts/system-prompt.ts` **only when the
  `BOOTSTRAP-ACTIVATION-RAIL.md` template is actually active** (i.e.
  `bootstrapTemplate === ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE`), which the web
  prechat context selects only for users whose
  `experiment-activation-flow-2026-06-03` cohort puts them on the rail. (It is
  also set up-front in `conversation.ts` `setOnboardingContext` so the marker is
  available before the first turn's tool resolution.)
- Emission is **gated on the marker at commit time**: when a tagged `ui_show`
  surface is committed, the daemon records the milestone only if
  `isActivationSession(conversationId)` is true. A stray `activation_moment` tag
  in a normal chat is therefore ignored and never pollutes the funnel. (`moment_4`
  / `first_wow_interacted` deduping is handled the same way as any other moment —
  see the dedup contract in §3 — and the per-surface tag is cleared after the
  first record so a single surface commit emits at most once.)

The activation **session id is the daemon `conversation_id`** of the rail
conversation. That same value is `session_id` on every activation event.

---

## 5. Local smoke-test runbook

Goal: drive one dev session through the activation cohort, emit all five events,
flush, and verify rows in BigQuery. Executable by another engineer.

### 5.1 Put the dev user in the activation cohort

The rail is gated by the LD flag `experiment-activation-flow-2026-06-03`. Two
options:

- **In-app feature-flags override (fastest):** open the in-app Feature Flags
  panel and force `experiment-activation-flow-2026-06-03` ON for the dev user.
- **LaunchDarkly targeting:** target the dev user for the flag in the LD
  dashboard (per the LD-flag-two-repo convention, targeting is dashboard-side).

When the flag is ON, the web prechat context selects
`BOOTSTRAP-ACTIVATION-RAIL.md` as the bootstrap template, and the daemon marks
the conversation in `activation_sessions` on first build of the system prompt.

### 5.2 Confirm share_analytics consent is on — and pick the right daemon mode

Two distinct concerns: whether record-time rows reach SQLite (consent gate), and
whether those rows reach BigQuery (flush gate, dev-disabled).

1. `recordActivationEvent` no-ops only on a confirmed `share_analytics` opt-out
   (it reads `getRawShareAnalytics()`); an `"unknown"` state records, but the
   flush defers until consent resolves. So for rows to actually SHIP, the dev
   session must be signed in to
   the platform with `share_analytics` consent enabled, or no rows reach
   SQLite. The consent cache is refreshed by `startConsentRefresh()` in
   `assistant/src/daemon/lifecycle.ts`, which runs **regardless of dev mode** — so
   a dev session signed in with `share_analytics` consent enabled writes
   record-time rows to SQLite, where they can be inspected directly.
2. **Dev mode disables the flush entirely.** When the daemon runs in dev mode
   (`VELLUM_DEV=1`), `assistant/src/daemon/lifecycle.ts` never starts the
   `UsageTelemetryReporter` — rows accumulate in SQLite (consent permitting) but
   are never POSTed, and the "wait/restart for flush" steps below will never reach
   BigQuery. For an end-to-end smoke test, run the daemon **outside dev mode** (so
   the reporter starts), or explicitly invoke the reporter's `flush()` via a dev
   hook. The SQLite rows can be inspected directly in dev mode, but the BigQuery
   verification (§6) requires a real flush.

### 5.3 Start a fresh activation conversation and capture its id

Start a brand-new conversation with the flag ON (it must be the rail bootstrap, so
start it from the web prechat flow / activation entry, not an existing chat).
Note its `conversation_id` — this is the `session_id` you will query on.

If multiple daemons are running, kill ALL `daemon/main.ts` processes, remove
`~/.vellum/vellum.sock`, and start fresh, so the conversation is served by a known
daemon writing to a known SQLite DB.

### 5.4 Drive the rail through all five model moments

Work the conversation through the rail moves so the model tags each surface and
you commit it (the model tags surfaces via `ui_show`'s `activation_moment`
parameter; which surface maps to which moment is documented in
`BOOTSTRAP-ACTIVATION-RAIL.md` and §2). Each milestone records when YOU commit
the tagged surface:

1. Commit the Port-summary card / no-port intake `choice` → `activation_moment_1_complete`.
2. Commit the Propose offer surface → `activation_moment_2_complete`.
3. Commit the task-selection surface → `activation_moment_3_complete`.
4. Commit the Run result surface → `activation_first_wow_executed`.
5. Click an action on the result surface → `activation_first_wow_interacted`.

### 5.5 Force / await a telemetry flush

The reporter flushes on a schedule: a first flush ~30s after startup
(`INITIAL_FLUSH_DELAY_MS`) and then every ~5 min (`REPORT_INTERVAL_MS`). Either:

- **Wait** for the next scheduled flush (≤ ~5 min), or
- **Restart the daemon** to take the ~30s post-startup flush, or
- call the reporter's `flush()` path directly if you have a dev hook into the
  running daemon.

A successful flush POSTs the unreported onboarding rows to
`/v1/telemetry/ingest/` as `type: "onboarding"` events.

### 5.6 Verify in BigQuery

Wait for the platform → GCS NDJSON → BigQuery pipeline to land the events, then
run the query in §6.

---

## 6. BigQuery verification query

```sql
SELECT step_name, step_index, COUNT(*) AS n
FROM `vellum-ai-prod.telemetry.onboarding_raw`
WHERE funnel_version = 'activation_v1_2026_06'
  AND session_id = '<dev conversation id>'
GROUP BY 1, 2
ORDER BY 2;
```

**Expected:** all five `activation_*` step names for the one session, step_index
1–5, each with `n = 1`:

```
activation_moment_1_complete      | 1 | 1
activation_moment_2_complete      | 2 | 1
activation_moment_3_complete      | 3 | 1
activation_first_wow_executed     | 4 | 1
activation_first_wow_interacted   | 5 | 1
```

A missing row means that milestone never emitted (re-drive that rail move); an
`n > 1` before dbt dedup is harmless (the deterministic `daemon_event_id`
collapses it earliest-wins).

---

## 7. Canonical handoff blurb (paste-ready for the final PR description)

> **Activation funnel telemetry — handoff for dashboard ticket.** The activation rail
> now emits five milestone funnel events into the existing onboarding telemetry
> substrate (`type: "onboarding"` → `/v1/telemetry/ingest/` → GCS NDJSON →
> `vellum-ai-prod.telemetry.onboarding_raw`), so no new event type, ingest
> endpoint, or BigQuery table is involved. Cohort is gated by the LaunchDarkly
> flag **`experiment-activation-flow-2026-06-03`**; only rail (treatment)
> conversations emit. Every event carries **`funnel_version =
"activation_v1_2026_06"`** and **`ab_variant`** tagged `"variant-a"` for
> treatment (`"control"` is the no-rail arm, measured for now from generic `turn`
> events). The event vocabulary (step_name → step_index): `activation_moment_1_complete`
> (1), `activation_moment_2_complete` (2), `activation_moment_3_complete` (3),
> `activation_first_wow_executed` (4), `activation_first_wow_interacted` (5).
> `session_id` is the rail conversation's id. The **north star** ("≥5 user
> messages within 24h per LD variant") is **not** a funnel event — compute it
> downstream by joining the existing `turn` telemetry events (`turn_index` per
> conversation) to the platform's `flag_assignment_raw` cohort-assignment table.
> **Dedup contract:** each row's `daemon_event_id` is deterministic,
> `${funnel_version}:${session_id}:${step_name}`, keyed on the row's stored
> `funnel_version`; the existing dbt earliest-wins dedup on `daemon_event_id`
> collapses any repeated moment to a single row. Build funnel conversion as a
> step_index 1→5 progression per `session_id`, filtered to `funnel_version =
'activation_v1_2026_06'`.

---

## 8. Notes

- **"naming check" (resolved).** Events fire **deterministically on
  the real user commit of a `ui_show` surface, not every text turn**. The model
  passively tags the surface for a rail move with `activation_moment`; the daemon
  records the milestone in `handleSurfaceAction` when the user commits that
  surface (firing conditions / surface→moment mapping documented in
  `BOOTSTRAP-ACTIVATION-RAIL.md`). This removes the standalone
  `emit_activation_event` tool (and its cohort preactivation) entirely and ties
  emission to a genuine user action, resolving the naming-check open
  interpretation.
- **Stream B (multivariate cohort flag conversion) is NOT in this work.** It is
  gated on the platform team's in-flight string-flag serving — until the platform
  can serve string/multivariate flags, flipping
  `experiment-activation-flow-2026-06-03` boolean→multivariate client-side would
  silently disable the live allowlisted rail. Until then, `ab_variant` is the
  constant `"variant-a"` (only treatment runs the rail), and the **control side**
  of the comparison is measured from generic `turn` events split by the
  platform's experiment exposure mapping. Once Stream B lands, the daemon tags the
  real assigned arm and the cross-cohort comparison works with zero rework.
