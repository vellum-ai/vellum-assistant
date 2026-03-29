# Platform Connect — Plan

## Definition of Done

- The user hatches an assistant without vellum login connected
- The user should be able to ask to connect their gmail
- The assistant sends back a UI component to login with Vellum first

## Completed PRs

- [X] add `assistant platform` sub-commands
- [X] add unit tests for above
- [X] Solve "Platform connect UI component not yet implemented" — PR merged & closed

---

## Remaining Tasks

### Task 1: Consolidate `assistant platform status` output
The `assistant platform status` command currently outputs the same information twice — once in JSON and once in plain text. Consolidate the output so it only appears once in a clean format.
- **Status:** Done — [PR #22140](https://github.com/vellum-ai/vellum-assistant/pull/22140)

### Task 2: Fix Docker related issues
1. Set `IS_CONTAINERIZED` to `false` in that environment
2. Fix the volumes of the container to match our setup in platform
- **Status:** Done — [PR #3374](https://github.com/vellum-ai/vellum-assistant-platform/pull/3374)

### Task 3: System prompt / skills clarification
Update the system prompt to clarify that any mention of the Vellum platform can be queried with the `assistant platform` CLI.
- **Status:** Done

### Task 4: Update gmail-skill E2E test to validate working
Ensure the gmail-skill E2E test validates the full platform connect flow end-to-end.

---

## Removed Items (per review 2026-03-29)
- ~~Debug: Desktop app fails to render Platform Connect component~~ (removed)
- ~~Fix the natural language flow to connect platform~~ (removed)

---

## Execution Model

- One PR per task
- Update this `plan.md` after completing each task (mark done, add PR link)
- Complete the entire plan in this session
