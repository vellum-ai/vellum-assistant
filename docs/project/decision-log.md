# Decision Log

Use this log for project-shaping decisions that affect architecture, scope, rollout, or UX.

## How To Use

- Add decisions in reverse-chronological order (newest first).
- Do not rewrite previous decisions; add a new decision that supersedes an old one when needed.
- Keep implementation details in code/PRs and keep rationale here.

## Decision Template

```md
## D-XXXX - Short decision title

- Date:
- Status: proposed | accepted | superseded
- Context:
- Options considered:
  - Option A:
  - Option B:
- Decision:
- Why:
- Follow-up impact:
- Supersedes:
```

## Decisions

## D-0002 - Keep roadmap strategic and split execution tracking into project docs

- Date: 2026-05-19
- Status: accepted
- Context:
  - `docs/jarvis-roadmap.md` already carries strategy and progress history.
  - Day-to-day execution tracking (status, evidence, decisions) needs a faster update surface.
- Options considered:
  - Option A: Keep everything in one roadmap document.
  - Option B: Introduce a small `docs/project/` tracking set and keep roadmap strategic.
- Decision:
  - Adopt Option B and use the `docs/project/` folder for execution tracking.
- Why:
  - Reduces mixing of long-range narrative with short-cycle status updates.
  - Makes weekly review and validation easier without rewriting roadmap history.
- Follow-up impact:
  - Maintain `workstream-tracker.md`, `validation-log.md`, and `decision-log.md` continuously.
  - Keep `jarvis-roadmap.md` as strategic source and durable progress chronology.
- Supersedes:
  - none

## D-0001 - Phase 10 remains the immediate execution focus

- Date: 2026-05-19
- Status: accepted
- Context:
  - Multiple Phase 10 streams are already in flight: autonomous execution, memory maturation, multimodal perception, host camera path, and related client/HUD support.
- Options considered:
  - Option A: Open new top-level initiatives before current Phase 10 streams stabilize.
  - Option B: Prioritize completion/hardening of the current Phase 10 vertical slice first.
- Decision:
  - Adopt Option B and prioritize stabilization, validation, and hardening of current streams.
- Why:
  - Improves end-to-end reliability and lowers risk before widening scope.
  - Aligns with current roadmap sequencing and feature-flagged rollout safety.
- Follow-up impact:
  - Use validation evidence to promote workstreams from `in_progress` to `done`.
  - Delay expansion work that does not directly increase Phase 10 reliability.
- Supersedes:
  - none
