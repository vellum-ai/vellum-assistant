---
name: orchestration
description: Decompose complex tasks into parallel specialist subtasks
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\U0001F500"
  vellum:
    display-name: "Orchestration"
    activation-hints:
      - "Multiple independent work streams that benefit from parallel execution"
    avoid-when:
      - "Single-focus tasks -- work directly"
---

Use `swarm_delegate` when facing complex multi-part tasks that benefit from parallel execution. The tool decomposes an objective into independent specialist subtasks, runs them concurrently, and synthesises the results.

## When to use

- The request involves **multiple independent work streams** (e.g. research + coding + review).
- Tasks can run in parallel without sequential dependencies.
- The combined work would take significantly longer if done serially.

## When NOT to use

- Simple single-step requests — just do them directly.
- Tasks that are inherently sequential (each step depends on the previous result).
- Requests where the user is asking for a quick answer, not a deep workflow.

## Tips

- Provide a clear, specific `objective`. The planner uses it to decompose the work.
- Pass relevant `context` about the codebase or project when available.
- The `max_workers` parameter caps concurrency (1-6); the default comes from config.
