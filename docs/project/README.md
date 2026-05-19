# Project Tracking Dashboard

This folder keeps day-to-day execution tracking separate from the long-range roadmap.

## Purpose

- Strategic direction and historical narrative live in [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md).
- Current execution status, validation evidence, and working decisions live in this folder.
- Update this dashboard first when priorities shift.

## Current Snapshot

- Current phase: Phase 10 (Jarvis vertical-slice MVPs in flight)
- Immediate priorities:
  - Stabilize autonomous execution and plan recovery flow.
  - Validate multimodal perception (camera/snapshot + audio excerpt) end to end.
  - Keep memory maturation quality signals accurate over time.
  - Keep Tauri HUD/client surfaces aligned with daemon events.
- Blocked items:
  - No hard blockers recorded yet (update this line when one appears).
- Next review checkpoint:
  - Weekly progress review and risk sweep.

## Core Docs

- Vision and end-state criteria: [`docs/project/target-state.md`](./target-state.md)
- Active workstream status: [`docs/project/workstream-tracker.md`](./workstream-tracker.md)
- Validation and what is proven: [`docs/project/validation-log.md`](./validation-log.md)
- Key decisions and rationale: [`docs/project/decision-log.md`](./decision-log.md)
- Strategic roadmap: [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md)
- System architecture index: [`ARCHITECTURE.md`](../../ARCHITECTURE.md)

## Update Rules

- Update [`docs/project/workstream-tracker.md`](./workstream-tracker.md) whenever work starts, completes, or becomes blocked.
- Update [`docs/project/validation-log.md`](./validation-log.md) after tests, smoke checks, or end-to-end verification.
- Update [`docs/project/decision-log.md`](./decision-log.md) when decisions affect architecture, scope, rollout, or UX.
- Keep [`docs/jarvis-roadmap.md`](../jarvis-roadmap.md) focused on phased strategy and durable progress history, not task-by-task execution notes.

## Fast Weekly Ritual

1. Refresh workstream statuses and next actions.
2. Add newly confirmed validation evidence and gaps.
3. Record new project-shaping decisions.
4. Confirm current phase and update immediate priorities.
