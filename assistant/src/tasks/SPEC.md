# One-Shot Tasks — Design Spec

One-shot tasks are user-defined, reusable prompt templates that run as
self-contained LLM invocations. A user creates a task once (template + input
schema), then triggers it with concrete inputs whenever needed. Each run
produces a result in an isolated background thread.

---

## 1. Template Format (v1)

A task definition consists of two parts:

### Prompt template

A plain-text string with `{{placeholder}}` markers. When a task is run, every
placeholder is replaced with the corresponding user-supplied value, and the
resulting string is sent to the LLM as the user message.

```
Summarize the following meeting notes in {{style}} format:

{{notes}}
```

Placeholder names must match `[a-zA-Z_][a-zA-Z0-9_]*`.

### Input schema

A JSON Schema object that describes every placeholder variable — its type,
description, and any validation constraints. This serves double duty: it
drives input validation before the run starts, and it provides enough metadata
for a UI to render an input form automatically.

```json
{
  "type": "object",
  "properties": {
    "style": {
      "type": "string",
      "enum": ["bullet", "narrative", "executive"],
      "description": "Output format for the summary"
    },
    "notes": {
      "type": "string",
      "description": "Raw meeting transcript or notes"
    }
  },
  "required": ["style", "notes"]
}
```

**Why this design:** A single text template is the simplest possible v1 — no
multi-message choreography, no branching, no tool-use orchestration. It covers
the most common use case (structured prompt with variable inputs) while leaving
room to extend later (e.g., multi-step chains, tool-enabled tasks).

---

## 2. Memory Isolation Policy

Each task's memory is scoped by its task ID:

```
scope_id = "task:{task_id}"
```

This means:

- **Cross-run learning**: All runs of the same task share the same memory
  scope. The LLM can accumulate knowledge about the task across invocations
  (e.g., learning the user's preferred summary style over time).
- **Isolation from default scope**: Task memory is completely separate from the
  user's main conversation memory (`scope_id = "default"`). A task cannot read
  or pollute the user's chat history, and vice versa.
- **Per-task boundaries**: Different tasks have different scopes and cannot see
  each other's memory.

This mirrors the existing `private:{id}` scoping pattern used by private
threads (see `conversation-store.ts`), extended to a new `task:` namespace.

---

## 3. Run Surface

Each task run creates a new conversation thread with `threadType: 'background'`.

### Lifecycle

1. **Start**: The daemon creates a `background` thread, substitutes template
   placeholders, and sends the prompt to the LLM. An IPC notification
   (`task_run_started`) is broadcast to all connected clients with the run ID,
   task ID, and thread ID.
2. **Completion**: When the LLM response is received and stored, the daemon
   broadcasts a `task_run_completed` notification with the run ID, task ID,
   thread ID, and a status (`success` | `error`).
3. **Visibility**: Background threads are excluded from the default thread list
   (existing behavior in `conversation-store.ts`). Clients can query for them
   explicitly to surface task results in a dedicated UI.

**Why background threads:** Reuses the existing `threadType: 'background'`
infrastructure. Task runs don't interrupt the user's current conversation, and
clients can choose how and when to display results (toast, panel, separate
tab).

---

## 4. Safety Invariants

- **No auto-execution**: Tasks are never triggered automatically. Every run
  requires an explicit user action (CLI command, API call, or UI button press).
- **Ephemeral permission bundles**: If a task is configured with tool access,
  the permission grants are scoped to the single run and discarded afterward.
  No persistent allowlist entries are created on behalf of a task.
- **High-risk tools always prompt**: Regardless of any task-level permission
  configuration, tools classified as `RiskLevel.High` (destructive shell
  commands, private-network fetches, etc.) always require interactive user
  confirmation. This invariant cannot be overridden by task definitions.

---

## 5. PR Dependency Chain

Implementation is split into sequential PRs, each building on the previous:

| PR | Title | What it delivers |
|----|-------|------------------|
| 0  | Spec decisions | This document. |
| 1  | Schema + storage | `tasks` and `task_runs` tables, Drizzle schema, migration in `db.ts`, CRUD functions in `task-store.ts`. |
| 2  | Template engine | `renderTemplate()` — placeholder substitution with input validation against the JSON Schema. |
| 3  | Run executor | `executeTaskRun()` — creates background thread, calls LLM, writes result, broadcasts IPC notifications (`task_run_started`, `task_run_completed`). |
| 4  | CLI surface | `vellum task create`, `vellum task run`, `vellum task list` commands. |
| 5  | IPC + macOS integration | Wire up IPC message types; macOS client displays task run results. |
