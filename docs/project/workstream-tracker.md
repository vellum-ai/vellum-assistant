# Workstream Tracker

Status labels: `not_started` | `in_progress` | `blocked` | `done`

Update this file whenever a workstream moves state, changes owner, or changes next action.

## Active Workstreams

| Workstream | Status | Goal | Next Action | Evidence Link | Blocker |
|---|---|---|---|---|---|
| Autonomous execution engine | in_progress | Reliable plan execution with durable step state, lifecycle events, and crash recovery | Run focused regression tests for plan routes, recovery, and lifecycle broadcasts; document any edge-case failures | [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md) | none |
| Memory maturation | in_progress | Improve long-term quality of entities/preferences/episodes with decay + reinforcement signals | Verify scoring and reinforcement behavior in realistic conversation sequences | [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md) | none |
| Multimodal perception | in_progress | Ingest and gate `screen_snapshot` and `audio_excerpt` with consent and sanitization guarantees | Validate consent-required paths and redaction coverage on newly wired routes/events | [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md) | none |
| Host camera snapshot path | in_progress | Provide bounded camera snapshot capability through host proxy and route surfaces | Complete route/proxy test pass and confirm client call path behavior | [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md) | none |
| Tauri HUD and client observability | in_progress | Surface meaningful real-time assistant state (action lifecycle, perception, voice cadence) | Validate HUD rendering and event subscriptions against current daemon contracts | [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md) | none |
| Voice fusion | in_progress | Inject perception context into live voice without degrading turn quality | Verify context injection quality on representative voice sessions | [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md) | none |
| Security hardening | in_progress | Keep new capabilities gated, auditable, and fail-closed while features land | Expand guard/test coverage whenever a new route, event, or host capability lands | [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md) | none |

## Backlog Queue (Post-Current Slice)

- Tauri Rust-native screen capture path (explicitly deferred in current roadmap slice).
- Additional proactive trigger tuning once current interruption budget behavior is stable.
- Wider multi-device UX polish after local end-to-end reliability is consistently green.

## Tracking Conventions

- Keep one row per meaningful workstream; avoid one row per tiny task.
- Put execution-level evidence into [`docs/project/validation-log.md`](./validation-log.md), not into status cells.
- Link follow-up PRs/issues under the matching row as they exist.
