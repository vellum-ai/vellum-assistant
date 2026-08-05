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

- **Spawn**: Use `subagent_spawn` with a label, objective, and type. The subagent runs autonomously.
- **Mid-run communication**: Subagents can send notifications to the parent via `notify_parent` while still running -- useful for sharing interim findings or signaling that they are blocked.
- **Auto-notification**: The parent conversation is automatically notified when a subagent reaches a terminal status (completed/failed/aborted). Do NOT poll `subagent_status`.
- **Read output**: Use `subagent_read` after the subagent reaches a terminal status to retrieve its full output.

## Types

There are three subagent types. Pick one with two questions: **does it need to change anything**, and **do you need its answer before you can continue?**

`recall` is local information search across memory, the personal knowledge base, past conversations, and workspace files. Use it when a subagent needs prior context that is not already in the prompt.

| Type | Changes things? | You wait? | Tools | When to use |
|---|---|---|---|---|
| `researcher` | No | No | `web_search`, `web_fetch`, `file_read`, `file_list`, `code_search`, `recall`, `skill_execute`, `notify_parent` | Web research, codebase exploration, reading documentation, root-cause investigation, reviewing an approach against the code |
| `builder` | Yes | No | Your whole tool surface, unrestricted: shell, file writes and edits, and every connector, MCP, and browser tool you can reach | Code changes, file output, build/test runs, anything that must run a command or act on an outside system |
| `advisor` | No | Yes | Read-only fact checking in the workspace: `file_read`, `file_list`, `code_search` | Read-only senior-advisor consult. Runs on a stronger model, inherits full parent context, and BLOCKS until it returns guidance |

Both background types can call `notify_parent` for mid-run communication with the parent.

A `researcher` is scoped to the fixed read-only list above: it cannot write or edit files, run commands, reach a connector, or otherwise persist output. If the task must **produce a file, save results, run a command, or act on an outside system**, spawn a `builder`: a researcher finishes without producing anything, and the delegated write silently no-ops.

**Model tier is a separate knob.** Use `inference_profile` to run any type on a stronger or cheaper model. **A persona is not a type**: see the fallback below.

### Legacy names and unknown roles

The older role names still work: `planner` and `investigator` run as a `researcher`, `coder` and `general` run as a `builder`. The spawn result names the type that actually ran.

Any other `role` text is treated as a persona, not a type. The subagent runs as a **`researcher`** (read-only) with that text framing how it approaches the task, and the spawn result says so. That is deliberate least privilege: an invented or misspelled role must never silently hand out write access. If the task genuinely needed to write, the subagent reports that it cannot, and you re-spawn it with `role: "builder"`.

Omitting `role` entirely runs a `builder`, so a spawn that names no type keeps your full tool surface.

### Verification

Checking that something is actually done is not a fourth type. It is a `researcher` with `output_contract: "verdict"`.

A verdict subagent returns, for each criterion in the objective, `PASS` or `FAIL` plus the exact evidence (file path, line, value, or quote), `CANNOT VERIFY` where the evidence is missing, and nothing else. Give it the criteria explicitly in the objective; a vague "check the work" gets you a vague list.

It runs on a cheaper model by default, because checking a claim against evidence that already exists is mechanical work, not investigation. An explicit `inference_profile` still wins if a check genuinely needs a stronger model, and so does a profile pinned on the `subagentSpawn` call site in config (see Inference Profile below).

The other contracts: `output_contract: "artifact"` tells a `builder` that the deliverable is the thing produced and to end by listing the exact files it created or modified. `"report"` is the default and asks for nothing extra. A contract that does not match the type is rejected rather than quietly changed, and the `advisor` takes no contract (it has its own framing).

## Consulting the Advisor

The `advisor` is the one type you spawn on your own judgment, unprompted: you do NOT wait for the user to ask for a subagent. The background types (`researcher`, `builder`) stay delegation-driven: reach for them to offload work, typically when the user's request calls for it. The advisor is different: proactively consult it whenever the conditions below are met.

Orient yourself first (read the relevant files, understand the task), then consult the advisor:

- **Before you commit to an approach and start building** — to shape a plan when you don't have one, or to pressure-test and sharpen a plan you've already drafted.
- **When you get stuck or are weighing a change in direction.**
- **Once before you declare the task done.**

The consult is synchronous and read-only: spawning an `advisor` subagent BLOCKS until it returns guidance. It runs on a stronger model and inherits your full context, so it sees the task, your tool calls, and their results without you re-explaining. It also receives a snapshot of your environment (the tools available to you this turn, the full skill catalog, and your workspace) so its guidance can point you at existing platform capabilities by name. Give its guidance serious weight; only override it when primary-source evidence contradicts a specific claim, and say so when you do.

The advisor has read-only workspace tools (`file_read`, `file_list`, `code_search`) so it can open a file or search the code when a decisive fact would change its advice. It uses them sparingly, for verification rather than exploration, and it cannot change anything or persist output. It has no memory search and cannot see other conversations or external systems, and every lookup it has to make delays your answer, so surface the evidence you already have (a file's contents, a command's output, results gathered elsewhere) in the conversation or the spawn objective before consulting.

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

## Repeat Spawns

Spawning an objective that several near-identical subagents have already completed in the last day can come back as a message about those earlier runs instead of a new subagent. Read what the earlier run produced with `subagent_read`, or narrow the objective to what is actually still missing.

A second message covers the other shape: near-identical copies that are still running and have returned nothing yet. There is nothing to read in that case, so wait for the running ones to report back, or narrow the objective to the part they are not covering.

Either way it is advisory, not a block: pass `confirm_repeat: true` to spawn anyway. An `advisor` consult is never held this way.

## Inference Profile

Set `inference_profile` to an `llm.profiles` key when a subagent should run under a specific model profile.

When it is omitted, the subagent takes the `subagentSpawn` call site's default model selection. It does not pick up the profile the spawning turn is running on: a profile pinned on a conversation is a choice about that conversation, and it does not follow the work that conversation delegates.

An `inference_profile` you name explicitly wins, unless the model catalog does not report it as tool-capable, in which case it is replaced by the `subagentSpawn` default with a note on the spawn result. An `advisor` consult applies that same fallback, with the note alongside its guidance.

`output_contract: "verdict"` takes a cheaper profile, so a verdict runs cheap unless you name an `inference_profile` yourself. A profile pinned on the `subagentSpawn` call site in config also beats the cheap preset, so an operator can decide what checks run on.

## Fork Mode

Forks are sub-agents that inherit the parent's full context -- messages, system prompt, and memory -- sharing the KV cache for near-free context inheritance. Use forks when the task benefits from knowing what you've been discussing; use a regular sub-agent when the task is self-contained.

**Key behaviors:** A fork honors the type you name, so `role: "researcher"` gives a read-only fork. A fork that names no type runs as a `builder` and so keeps your full tool surface, which is what the system prompt it inherits describes. A persona reaches a fork through its task framing rather than its prompt, since the prompt is yours verbatim. `send_result_to_user` defaults to `false`. Read fork output with `last_n: 1` to get only the final synthesis.

**When to fork vs regular sub-agent:**

| Task | Mode |
|---|---|
| Single tool call (one search, one file read) | Direct -- don't spawn at all |
| Multi-page web research needing conversation context | Fork |
| Exploratory file search informed by prior discussion | Fork |
| Comparing multiple sources against what was discussed | Parallel forks |
| Self-contained task with a clear objective | Regular sub-agent |

Rule of thumb: "Does this task need to know what we've been talking about?" If yes, fork. If the objective is fully self-describing, use a regular sub-agent with a scoped type.

## Tips

- Do NOT poll `subagent_status` in a loop. You will be notified automatically when a subagent completes.
- Prefer `researcher` unless the task has to change something. Read-only is the smaller blast radius, and most delegated work is reading.
- Spawn a `researcher` and a `builder` in parallel for research-then-implement workflows -- the researcher gathers context while the builder starts on the known parts.
- Use `notify_parent` for interim findings instead of waiting for completion. This lets the parent act on partial results early.
- Use `subagent_message` to send follow-up instructions to a running subagent.
- Use `subagent_abort` to cancel a subagent that is no longer needed.
- Default to spawning subagents for any task that involves web research, multi-file exploration, or independent coding work. Serial execution should be the exception, not the rule.
- Delegate root-cause investigations ("why is X happening?", debugging, log forensics) to a `researcher` instead of grepping inline. A long investigation done inline floods your own context with file slices and grep output, crowding out the conversation; the researcher does the digging in its own context and returns a compact root-cause report.
- When a user request has both an information-gathering component and an action component, spawn a researcher immediately rather than doing the research inline yourself.
- Prefer spawning 2-3 focused subagents over one broad one. Smaller scopes finish faster and fail more gracefully.
