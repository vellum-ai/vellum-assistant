---
name: subagent
description: Spawn and manage autonomous background agents for parallel work
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🤖"
  vellum:
    display-name: "Subagent"
    category: "system"
    activation-hints:
      - "Spawn a background worker that runs in parallel with the main turn"
      - "Delegate a self-contained research or implementation task off the main thread"
      - "Multiple agents at once, or a context-inheriting fork"
    avoid-when:
      - "Task is small enough to do inline (single tool call, quick lookup)"
      - "User wants Claude Code or Codex — use the acp skill instead"
---

Subagent orchestration -- spawn background agents to work on tasks in parallel.

## Lifecycle

Subagents follow this status flow: `pending` -> `running` -> `completed` / `failed` / `aborted`

- **Spawn**: Use `subagent_spawn` with a label, objective, and role. The subagent runs autonomously.
- **Mid-run communication**: Subagents can send notifications to the parent via `notify_parent` while still running -- useful for sharing interim findings or signaling that they are blocked.
- **Auto-notification**: The parent conversation is automatically notified when a subagent reaches a terminal status (completed/failed/aborted). Do NOT poll `subagent_status`.
- **Read output**: Use `subagent_read` after the subagent reaches a terminal status to retrieve its full output.

## Roles

Each subagent is spawned with a role that determines its tool access. Choose the most restrictive role that can accomplish the task.

`recall` is local information search across memory, the personal knowledge base, past conversations, and workspace files. Use it when a subagent needs prior context that is not already in the prompt.

| Role | Tools | When to use |
|---|---|---|
| `general` | Full tool access | Task genuinely needs unrestricted capabilities (rare -- prefer a specialized role) |
| `researcher` | `web_search`, `web_fetch`, `file_read`, `file_list`, `recall`, `notify_parent` | Information gathering, web research, codebase exploration, reading documentation |
| `coder` | `bash`, `file_read`, `file_write`, `file_edit`, `web_search`, `recall`, `notify_parent` | Code changes, file editing, running commands, build/test tasks |
| `planner` | `file_read`, `file_list`, `web_search`, `web_fetch`, `recall`, `notify_parent` | Analysis, planning, synthesizing information, reviewing approaches |
| `investigator` | `code_search`, `file_read`, `file_list`, `web_search`, `web_fetch`, `recall`, `notify_parent` | Root-cause analysis: debugging, log forensics, tracing behavior across many files. Read-only search/read tools only (no shell): use `code_search` to grep file contents across directories, `file_list` to enumerate paths, `file_read` to read whole files and logs; returns a compact root-cause report |
| `advisor` | None (tool-less) | Read-only senior-advisor consult. Runs on a stronger model, inherits full parent context, and BLOCKS until it returns guidance |

All specialized roles (`researcher`, `coder`, `planner`) include `notify_parent` for mid-run communication with the parent.

## Consulting the Advisor

The `advisor` role is the one role you spawn on your own judgment, unprompted — you do NOT wait for the user to ask for a subagent. The other roles (`researcher`, `coder`, `planner`, `investigator`, `general`) stay delegation-driven: reach for them to offload work, typically when the user's request calls for it. The advisor is different: proactively consult it whenever the conditions below are met.

Orient yourself first (read the relevant files, understand the task), then consult the advisor:

- **Before you commit to an approach and start building** — to shape a plan when you don't have one, or to pressure-test and sharpen a plan you've already drafted.
- **When you get stuck or are weighing a change in direction.**
- **Once before you declare the task done.**

The consult is synchronous and read-only: spawning an `advisor` subagent BLOCKS until it returns guidance. It runs on a stronger model and inherits your full context, so it sees the task, your tool calls, and their results without you re-explaining. Give its guidance serious weight; only override it when primary-source evidence contradicts a specific claim — and say so when you do.

Spawn the advisor **alone** — do NOT batch the consult in the same turn as other tool calls (especially file edits, shell commands, or anything destructive or expensive). Tool calls you issue in the same turn run concurrently with the consult, so they would execute before you see its guidance. Consult the advisor by itself, read its guidance, then act.

## Parent Communication

Subagents use `notify_parent` to send messages to the parent conversation while still running. Each notification has an urgency level:

- **`info`** -- Progress updates, minor findings. The parent is informed but does not need to act.
- **`important`** -- Key findings, significant results. The parent should review when convenient.
- **`blocked`** -- The subagent needs guidance or a decision from the parent to continue.

Use notifications judiciously -- one per major finding or milestone. Do not send a notification for every small step.

## Naming

Subagents can be referenced by label instead of UUID. The `label` parameter is accepted on `subagent_message`, `subagent_status`, `subagent_read`, and `subagent_abort` as an alternative to `subagent_id`. Label lookup is case-insensitive.

Use descriptive labels when spawning subagents (e.g., "research-auth-libraries", "implement-login-form") so they are easy to reference later.

## Reading Output

`subagent_read` returns the subagent's assistant text output. Use the `last_n` parameter to retrieve only the most recent N assistant messages instead of the full history. This is useful for large outputs where you only need the final result.

## Ownership

Only the parent conversation that spawned a subagent can interact with it (check status, send messages, abort, or read output).

## Silent Mode

Set `send_result_to_user: false` when spawning a subagent whose result is for internal processing only. The parent will still be notified on completion, but the notification will instruct it to read the result without presenting it to the user.

## Inference Profile

Set `inference_profile` to an `llm.profiles` key when a subagent should run under a specific model profile. When omitted, the subagent inherits the parent turn's active profile if one exists; otherwise it uses the `subagentSpawn` call site's default model selection.

## Fork Mode

Forks are sub-agents that inherit the parent's full context -- messages, system prompt, and memory -- sharing the KV cache for near-free context inheritance. Use forks when the task benefits from knowing what you've been discussing; use a regular sub-agent when the task is self-contained.

**Key behaviors:** Forks default to `general` role (the `role` parameter is ignored for forks), except the special `advisor` role, which is honored even as a fork. `send_result_to_user` defaults to `false`. Read fork output with `last_n: 1` to get only the final synthesis.

**When to fork vs regular sub-agent:**

| Task | Mode |
|---|---|
| Single tool call (one search, one file read) | Direct -- don't spawn at all |
| Multi-page web research needing conversation context | Fork |
| Exploratory file search informed by prior discussion | Fork |
| Comparing multiple sources against what was discussed | Parallel forks |
| Self-contained task with a clear objective | Regular sub-agent |

Rule of thumb: "Does this task need to know what we've been talking about?" If yes, fork. If the objective is fully self-describing, use a regular sub-agent with a scoped role.

## Tips

- Do NOT poll `subagent_status` in a loop. You will be notified automatically when a subagent completes.
- Use roles to scope tool access and minimize blast radius. Default to the most restrictive role that works.
- Spawn a `researcher` and `coder` in parallel for research-then-implement workflows -- the researcher gathers context while the coder starts on the known parts.
- Use `notify_parent` for interim findings instead of waiting for completion. This lets the parent act on partial results early.
- Use `subagent_message` to send follow-up instructions to a running subagent.
- Use `subagent_abort` to cancel a subagent that is no longer needed.
- Default to spawning subagents for any task that involves web research, multi-file exploration, or independent coding work. Serial execution should be the exception, not the rule.
- Delegate root-cause investigations ("why is X happening?", debugging, log forensics) to an `investigator` instead of grepping inline. A long investigation done inline floods your own context with file slices and grep output, crowding out the conversation; the investigator does the digging in its own context and returns a compact root-cause report.
- When a user request has both an information-gathering component and an action component, spawn a researcher immediately rather than doing the research inline yourself.
- Prefer spawning 2-3 focused subagents over one large general-purpose subagent. Smaller scopes finish faster and fail more gracefully.
