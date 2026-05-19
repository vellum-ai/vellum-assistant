---
name: plans
description: Create, inspect, update, or cancel confirmed multi-step plans the assistant is tracking. Use when the user asks Eli to help accomplish a task, asks what the assistant is doing, why something is taking long, or to stop a long-running task.
compatibility: "Designed for Vellum personal assistants. Requires the assistant's autonomous-execution feature flag."
metadata:
  emoji: "🧭"
  vellum:
    display-name: "Plans"
    activation-hints:
      - "User asks 'what are you doing right now' or 'what's running'"
      - "User asks the assistant to stop, pause, or abort a long task"
      - "User asks why a task is still in progress"
    avoid-when:
      - "The task is a single one-shot tool call; plans are for user-visible multi-step goals"
      - "The user wants to inspect schedules or cron jobs (use the schedules surface instead)"
featureFlag: autonomous-execution
---

## Overview

The Autonomous Execution Engine breaks long-running goals into ordered,
crash-recoverable steps. This skill is the **confirmed task companion**
surface over those plans: create a plan after the user has agreed to it,
inspect progress, update visible step status, or cancel work.

Creating or updating a plan does **not** execute host actions. Normal file,
shell, browser, computer-use, email, and other meaningful actions must still
go through their existing tool and approval gates.

A plan has three layers:

1. `plans` — one row per autonomous goal, with `status ∈ pending | running
   | completed | failed | cancelled`.
2. `plan_steps` — ordered steps within a plan, each with its own status.
3. `plan_step_runs` — append-only attempt history per step. Recovery on
   daemon restart flips stuck running runs to `recovered` so the runner
   can resume cleanly.

## Create a confirmed plan

Only create a plan after the user has confirmed the proposed goal and steps.
Keep steps short, ordered, and user-visible.

```bash
bun ./skills/plans/scripts/plan-control.ts create \
  --goal "Prepare the weekly status update" \
  --steps-json '["Collect open work","Draft status summary","Ask user to review"]'
```

Options:

- `--conversation-id <id>`: associate the plan with the active conversation
  when the skill context does not provide it automatically.
- `--scope-id <id>`: defaults to `default`.
- `--steps-json <json>`: non-empty JSON array of strings or
  `{ "name": "...", "input": { ... } }` objects.

Calls `POST /v1/plans`.

## List recent plans

```bash
bun ./skills/plans/scripts/plan-control.ts list --limit 20
```

Options:

- `--scope-id <id>`: defaults to `default`.
- `--limit <n>`: 1..200, default 50.

Calls `GET /v1/plans`.

## Inspect a single plan

```bash
bun ./skills/plans/scripts/plan-control.ts get <plan-id>
```

Returns the plan row, its ordered steps, and all step-run attempts.
Calls `GET /v1/plans/:id`.

## Cancel a plan

```bash
bun ./skills/plans/scripts/plan-control.ts cancel <plan-id> --reason "user requested"
```

The runner checks `status` between steps and stops cleanly. Already-terminal
plans return `{ cancelled: false }` and are unchanged. Calls
`POST /v1/plans/:id/cancel`.

## Update step status

Use this after visible progress changes. Do not mark a step complete unless
the work represented by that step is actually done.

```bash
bun ./skills/plans/scripts/plan-control.ts update-status <plan-id> <step-id> \
  --status completed
```

Supported statuses:

- `running`: Eli is actively working the step.
- `completed`: the step is finished.
- `blocked`: the step cannot proceed yet; include `--blocked-reason`.
- `pending`, `failed`, `skipped`: available for explicit repair or recovery
  flows when needed.

Blocked example:

```bash
bun ./skills/plans/scripts/plan-control.ts update-status <plan-id> <step-id> \
  --status blocked \
  --blocked-reason "Waiting for the user to choose which branch to deploy"
```

Calls `POST /v1/plans/:id/steps/:stepId/status`.

## Response interpretation

When answering the user:

1. State the plan's `goal` and current `status` in plain language.
2. Summarize step progression ("step 2 of 4 in progress").
3. If a step `failed`, surface its `errorMessage` directly — do not paraphrase.
4. If a step is `blocked`, surface `blockedReason` when present and ask for
   the smallest next decision needed to unblock it.
5. If the plan is `cancelled`, surface `cancellationReason` when present.
6. Never invent steps that aren't in the response.

## Security rules

- Treat plan goals and step inputs as user-private context.
- Do not ask the user for tokens or secrets in chat. Use the runtime-provided
  environment when available.
- Creating a plan requires prior user confirmation in the conversation.
- Updating status must reflect actual progress; never use it to imply work
  was done by a tool that has not run.
- This skill does not run plans or grant action permissions.
