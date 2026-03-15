# One-Shot Tasks — Design Spec

One-shot tasks are user-defined, reusable prompt templates that run as
self-contained LLM invocations. A user creates a task once (template + input
schema), then triggers it with concrete inputs whenever needed. Each run
produces a result in an isolated background conversation.

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
conversations (see `conversation-crud.ts`), extended to a new `task:` namespace.

---

## 3. Run Surface

Each task run creates a new background conversation with `conversationType: 'background'`.

### Lifecycle

1. **Preflight**: The client requests a permission preflight for the work item.
   The daemon classifies risk for each required tool and returns the permission
   set. The client displays an approval dialog; approved tools are stored on
   the work item.
2. **Start**: The daemon creates a `background` conversation, substitutes
   template placeholders, sets up ephemeral permission rules for the approved
   tools, and processes the rendered prompt through a daemon `Session`. Status
   updates are broadcast to all connected clients via `work_item_status_changed`
   and `tasks_changed` SSE events.
3. **Completion**: When the session finishes, the work item transitions to
   `awaiting_review` (on success) or `failed` (on error). The daemon broadcasts
   the final status to all clients.
4. **Visibility**: Background conversations are excluded from the default conversation
   list (existing behavior in `conversation-crud.ts`). Clients can query for
   them explicitly to surface task results in a dedicated UI.

**Why background conversations:** Reuses the existing `conversationType: 'background'`
infrastructure. Task runs don't interrupt the user's current conversation, and
clients can choose how and when to display results (toast, panel, separate
tab).

---

## 4. Safety Invariants

- **Explicit trigger required**: Task runs are triggered either by an explicit
  user action (UI button press, API call) or by a user-configured schedule
  (`run_task:<task_id>` via the scheduler).
- **Ephemeral permission bundles**: If a task is configured with tool access,
  the permission grants are scoped to the single run and discarded afterward.
  No persistent allowlist entries are created on behalf of a task.
- **High-risk tools require upfront approval**: Tools classified as
  `RiskLevel.High` (destructive shell commands, private-network fetches, etc.)
  are surfaced in the preflight dialog so the user can explicitly approve or
  deny them before execution begins. During the run itself, approved tools
  (including high-risk ones) execute without further prompting.

---

## 5. Implementation Notes

The implementation is complete. Key modules:

| Module                           | What it delivers                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `task-store.ts`                  | `tasks` and `task_runs` tables, CRUD functions.                                                    |
| `task-runner.ts`                 | `runTask()` — creates background conversation, renders template, processes through daemon Session. |
| `ephemeral-permissions.ts`       | Scoped permission rules for the duration of a single task run.                                     |
| `work-items.ts` (daemon handler) | HTTP handlers for preflight, run, cancel, and status queries.                                      |
| Bundled skill (`tasks/`)         | Tool definitions (`task_save`, `task_run`, `task_list`, `task_delete`, `task_list_*`) for the LLM. |
