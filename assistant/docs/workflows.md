# Workflows — Authoring Guide

The workflow engine lets the assistant author a short JS/TS script that runs in a
sandbox and fans work out across many parallel, ephemeral **leaf agents**. A
workflow is the right tool when a task decomposes into a lot of similar small
sub-tasks that can run concurrently — score every item in a list, extract a field
from each of a hundred documents, draft-then-verify a batch — and you want the
results orchestrated deterministically and reported back when the whole run
finishes.

The `run_workflow` / `manage_workflows` tools are served by the `workflows`
bundled skill rather than as always-on tools — load it with `skill_load` and invoke
its tools via `skill_execute`.

- Engine code: `assistant/src/workflows/`
- Skill (tool surface): `assistant/src/config/bundled-skills/workflows/`
- Architecture overview: [`ARCHITECTURE.md` § Workflow Orchestration Engine](../../ARCHITECTURE.md#workflow-orchestration-engine)
- Manual e2e runbook: [`workflows-testing.md`](./workflows-testing.md)

---

## Why it works this way (design rationale)

### The sandbox is hooks-only because scripts may be authored from untrusted input

A workflow script can be written by the assistant **after** it has read untrusted
content — a hostile email, a web page, a shared document. The script must
therefore be unable to do anything on its own. It runs in a fresh QuickJS-WASM VM
per run with **no** `fetch`, `XMLHttpRequest`, `WebSocket`, `process`, `Bun`,
`require`, no dynamic `import()`, no timers, no filesystem, and no network. The
only way a script affects the outside world is through the host functions the
engine injects (`agent`, `parallel`, …). There are no ambient capabilities to
escalate, and the sandbox stops the script from reaching around its declared
capabilities.

### The capability declaration is the single consent point

A run declares **once**, up front, which side-effecting tools and host functions
its leaves may use and whether they may speak in the assistant's persona. That
declaration is the only place consent is given for the whole run — there are **no
per-call permission prompts inside a running workflow**. This is deliberate: a
run may spawn hundreds of leaves, and prompting per call would be unworkable and
would defeat the point of unattended fan-out. Leaves always get a curated
read-only baseline for free; anything that writes, sends, or executes must be
named in the manifest.

### The runaway guard is the agent cap — by design, no dollar kill-switch

The only structural limit on a run is the **agent cap** (`maxAgentsPerRun`,
default 500): the total number of leaves a single run may spawn. There is
intentionally **no spend/dollar kill-switch**. The cap bounds the blast radius in
a way that is deterministic and resume-safe (it counts agents, not wall-clock or
cost), and leaves default to a cost-optimized model. Concurrency is separately
bounded by `maxConcurrentLeaves` (default 6).

### Scripts must be deterministic so runs can resume

Every leaf call is journaled by a deterministic sequence number and an input
hash. If the assistant restarts mid-run, resuming the same `runId` **replays
the unchanged prefix from the journal** instead of re-spawning agents — so a
long run survives a deploy or crash without redoing (or re-paying for) completed
work. (Resume is explicit, not automatic — see
[Recovering a crashed run](#recovering-a-crashed-run).) That guarantee only
holds if the script is deterministic, so `Date.now()`, `Math.random()`, and
argless `new Date()` **throw**. Pass any timestamps or seeds in through `args`.

---

## The script model

### Scripts are SYNCHRONOUS — never use `await`

This is the single most important authoring fact. Host functions are _asyncified_:
calling one suspends the entire VM until the host-side promise settles, then
resumes the VM with the value. From the script's perspective every host call is
**synchronous** — you call it and the result comes back directly:

```js
const r = agent("Summarize this thread."); // r is the result, right here
```

Do **not** write `await agent(...)`, and do **not** make the script `async`.
Asyncify can only suspend the main evaluation stack, never a promise
continuation, so an `async`/`await` script would deadlock on its second host
call. Write plain straight-line code.

### Every script starts with a literal `meta`

The first thing in a script must be a pure-literal export — no computed values,
template strings, or concatenation:

```js
export const meta = {
  name: "triage-inbox",
  description: "Triage and label inbox messages",
};
```

`meta` is extracted **statically**, without executing the script (the source is
untrusted), so it must be a plain object literal with string `name` and
`description`. The `name` is how a saved workflow is referenced by `workflow(name)`
and the scheduler.

The script's result is whatever it `return`s at the top level. End with
`return <result>;` — the script body runs as a function, so a bare trailing
expression (e.g. `result;`) is **discarded** and the run finishes with no
result. Always `return` the value you want surfaced:

```js
const result = agent(`Write the final summary: ${JSON.stringify(parts)}`);
return result; // returned as the run result
```

---

## Host API reference

All functions are synchronous from the script's perspective.

| Function                     | Returns                                        | Notes                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, opts?)`       | the leaf's result                              | Runs ONE leaf. **Throws** on leaf failure.                                                                                                                     |
| `leaf(prompt, opts?)`        | a leaf descriptor                              | Runs nothing on its own; used inside `parallel`/`map`/`pipeline`.                                                                                              |
| `parallel(specs)`            | `results[]`                                    | Runs an array of `leaf(...)` descriptors concurrently (capped at `maxConcurrentLeaves`), results in input order. A failed leaf becomes `null` (never throws).  |
| `map(items, build)`          | `results[]`                                    | `build(item, i)` returns a `leaf(...)` descriptor (or a bare prompt string) per item; runs them like `parallel`.                                               |
| `pipeline(items, ...stages)` | `results[]`                                    | Each `stage(prev, i)` returns a `leaf(...)` descriptor or a plain value, where `prev` is the prior stage's result at index `i`. Per-stage barrier (see below). |
| `phase(title)`               | —                                              | Marks a named phase; surfaced as a progress event.                                                                                                             |
| `log(msg)`                   | —                                              | Emits a progress log line.                                                                                                                                     |
| `usage()`                    | `{ agentsSpawned, inputTokens, outputTokens }` | Live snapshot so a script can self-moderate.                                                                                                                   |
| `workflow(name, args?)`      | the child's result                             | Runs a SAVED workflow inline, depth 1 only (see Nesting).                                                                                                      |
| `args`                       | the run input                                  | The `args` object passed to `run_workflow`.                                                                                                                    |

### `agent` vs `parallel` failure semantics

`agent(...)` is for a single sequential leaf and **throws** if that leaf fails —
an unhandled throw fails the whole run. `parallel(...)` is the fan-out primitive
and **never throws on a single leaf**: a failed leaf is `null` in the results
array, so a batch survives a few bad items. `map` and `pipeline` are built on
`parallel` and share that null-on-failure behavior.

### `pipeline` has a per-stage barrier

`pipeline(items, stageA, stageB)` runs `stageA` across all items in parallel,
**waits for all of stage A to finish**, then runs `stageB` across stage A's
results. There is no cross-stage streaming in v1 — item _n_ does not advance to
stage B early just because its stage A finished first. Each `stage(prev, i)`
callback receives the prior stage's result for index `i`. This barrier is a
consequence of the single-threaded VM and is honest about its cost: a pipeline is
only as fast as the slowest leaf in each stage.

### Leaf options (`opts` for `agent` / `leaf`)

| Option    | Type                       | Effect                                                                                                           |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `schema`  | JSON Schema object literal | Forces structured output via a tool. A schema leaf runs with **no tools** — no read/recall; pass content inline. |
| `label`   | string                     | Short display/diagnostic label for the leaf.                                                                     |
| `profile` | string                     | Overrides the model profile. Must exist in `llm.profiles` or the leaf throws.                                    |
| `persona` | boolean                    | `true` makes the leaf speak as the assistant (identity + memory). Default is anonymous.                          |

#### `schema` is a JSON Schema literal, not Zod

A script runs in the sandbox and cannot hold a host-side Zod object, so a leaf's
`schema` is a plain **JSON Schema object literal**. The engine builds a forced
`tool_choice` call whose synthetic tool input is that schema, validates the
model's output against it, and returns the structured object. A leaf with a
`schema` is a pure judge/extractor — it gets **no tools**, so it has no
`file_read`/`file_list`/`recall`/`web_search` and **cannot read files or recall
memory**. Anything it must judge has to be passed **inline** in the prompt; a
schema leaf told to "read these files" will confabulate against the schema. (To
read first and then emit structured output, use a tool leaf that returns JSON in
its text and parse it yourself.)

```js
leaf(`Score this option 0-10 for fit: ${opt}`, {
  schema: {
    type: "object",
    properties: { score: { type: "number" } },
    required: ["score"],
  },
});
```

#### `persona` vs anonymous leaves, and profile resolution

By default a leaf is **anonymous**: a minimal task-scoped system prompt, no
assistant identity, no memory pipeline. Use anonymous leaves for impartial
judging, scoring, and extraction of input — the bulk of fan-out work.

`persona: true` opts the leaf into **persona mode**: it carries the assistant's
identity system prompt and runs the same memory-injection pipeline a normal turn
uses, so its output is authentically the assistant's voice (e.g. drafting a reply
to be sent). This is the costly path — use it for the small number of leaves whose
output is meant to be _in the assistant's voice_, not for bulk judging.

Model profile resolution:

- An explicit `profile` always wins and is validated up front — an unknown
  profile throws (a deliberate, loud failure rather than a silent downgrade).
- With no explicit `profile`, a **persona** leaf mirrors the main agent: the
  workspace `activeProfile` floats above the call-site default (a deleted/stale
  active profile degrades gracefully to the default).
- With no explicit `profile`, an **anonymous** leaf uses the shipped
  `workflowLeaf` call-site default (cost-optimized).

No leaf — anonymous or persona — ever creates a conversation row, jsonl mirror,
title job, or turn broadcast. Leaves are ephemeral.

---

## Capability manifest semantics

The `capabilities` argument to `run_workflow` is the single consent point:

```jsonc
{
  "tools": ["file_write", "gmail_send"], // side-effecting tools granted to leaves
  "hostFunctions": [], // host-function names the run may invoke
  "persona": true, // grant leaves persona (identity + memory) access
}
```

Resolution: the leaf tool set is the **read-only baseline ∪ declared `tools`**,
minus a forbidden set.

- **Read-only baseline** (always available, no declaration needed): `file_read`,
  `file_list`, `recall`, `web_search`. The baseline is auto-granted with no
  launch approval, so it carries only read-only tools. `web_fetch` is **not**
  here — it is classified as a side-effect tool (its URL can exfiltrate read data
  or trigger external actions), so a run that needs it must declare it (which
  arms the threshold-aware launch approval gate).
- **Declared tools** must exist in the tool registry — an unknown name is a hard
  authoring error, not a silent drop.
- **Forbidden tools** can never be granted, even if declared (declaring one is a
  hard error): `subagent_spawn`, `run_workflow`, `manage_workflows`,
  `manage_secure_command_tool`, `run_authenticated_command`,
  `make_authenticated_request`. The first four are recursion vectors or
  human-in-the-loop install paths that must not be delegated to an unattended
  leaf. The two CES tools can return `cesApprovalRequired`, which `ToolExecutor`
  resolves by bridging an interactive approval and retrying with a grant; a leaf
  executes `tool.execute()` directly (bypassing that post-processing), so it
  would see the raw approval-required result as an error. They stay forbidden
  until leaf invocations run the executor's post-processing.

Side-effecting tools (`file_write`, sends, shell, …) and `persona` are **not** in
the baseline; a run must declare them. Once declared, every leaf may use them with
no further prompting.

### Launch and resume approval are threshold-aware

Declaring any side-effecting tool or host function arms a **launch approval**: the
single point at which the user consents to the whole run. It is threshold-aware —
at the full-access posture (auto-approve threshold `high`) it does **not** prompt;
in normal posture it prompts once. A read-only run (no declared side effects)
never prompts.

The same posture gates **resume** of a run whose stored manifest granted side
effects, since resuming restarts the unfinished side-effecting leaves:

- **Conversationally** (`manage_workflows` action `resume`): full access bypasses;
  normal posture re-prompts for fresh approval.
- **Over HTTP** (`POST /v1/workflows/runs/:id/resume`, and the
  `vellum workflows resume` CLI on top of it): full access proceeds; normal
  posture is **refused** (403) and the caller is directed to resume through the
  assistant, since the route has no prompt channel.

A read-only run resumes freely regardless of posture. The check is
`isFullAccessThreshold` in `assistant/src/permissions/threshold.ts`, applied in
`permission-checker.ts` and `workflow-routes.ts`.

---

## Worked examples

### Triage a list with `map`

Score and label each inbox item in parallel (anonymous schema leaves), then write
one summary in the assistant's voice (a single persona leaf). The item list is
passed in via `args` — never fetched inside the script.

```js
export const meta = {
  name: "triage-inbox",
  description: "Score and summarize inbox items",
};

phase("score");
const scored = map(args.items, (item) =>
  leaf(
    `Rate this message's urgency 0-10 and give a one-line reason:\n${item.subject}\n${item.body}`,
    {
      label: `score:${item.id}`,
      schema: {
        type: "object",
        properties: {
          urgency: { type: "number" },
          reason: { type: "string" },
        },
        required: ["urgency", "reason"],
      },
    },
  ),
);

phase("summarize");
const summary = agent(
  `Here are scored inbox items. Write a short triage summary for the user, ` +
    `highlighting anything urgent:\n${JSON.stringify(scored)}`,
  { persona: true },
);
return summary;
```

A failed scoring leaf shows up as `null` in `scored`; the run continues.

### Find, then verify, with `pipeline`

A two-stage pipeline with a barrier: stage 1 extracts a candidate answer from each
document; stage 2 verifies each candidate. Stage 2 only starts once all of stage 1
has finished.

```js
export const meta = {
  name: "find-and-verify",
  description: "Extract then verify a fact per document",
};

const verified = pipeline(
  args.documents,

  // Stage 1: extract a candidate from each document.
  (doc) =>
    leaf(
      `Extract the contract end date from this document, or "unknown":\n${doc.text}`,
      {
        label: `extract:${doc.id}`,
        schema: {
          type: "object",
          properties: { endDate: { type: "string" } },
          required: ["endDate"],
        },
      },
    ),

  // Stage 2: `prev` is stage 1's result for this index.
  (prev, i) =>
    leaf(
      `A prior pass extracted end date "${prev?.endDate}" from document ` +
        `"${args.documents[i].id}". Confirm or correct it, and rate your confidence 0-1.`,
      {
        label: `verify:${args.documents[i].id}`,
        schema: {
          type: "object",
          properties: {
            endDate: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["endDate", "confidence"],
        },
      },
    ),
);

return verified;
```

### Granting a side-effecting tool

To let leaves write files, declare the tool in the manifest passed to
`run_workflow`:

```jsonc
{
  "script": "...",
  "args": {
    "items": [
      /* ... */
    ],
  },
  "capabilities": { "tools": ["file_write"] },
}
```

Inside the script, a leaf that needs to write gets `file_write` automatically (no
schema, so it runs the tool path):

```js
agent(`Write a per-item report file for: ${JSON.stringify(item)}`, {
  label: `report:${item.id}`,
});
```

---

## Saved workflows (library) and the scheduler

### Saving and invoking by name

A saved workflow is a normal script at `<workspace>/workflows/<name>.workflow.ts`.
It is resolved by its `meta.name` first, then by filename base. Invoke it by name
instead of an inline script:

- From the tool: `run_workflow({ name: "triage-inbox", args: { … } })`.
- Inline from another script: `workflow("triage-inbox", { … })`.

### Nesting is depth-1 only

A top-level script may call `workflow(name, args)` to run a saved workflow inline;
the child draws from the **same** seq counter, agent cap, journal, and signal, so
determinism and resume carry across the boundary. A child workflow may **not**
call `workflow()` — nesting deeper than one level throws.

### Scheduler `workflow` mode

A scheduled job can trigger a saved workflow by name (e.g. "triage the inbox every
morning"). Each `workflow`-mode schedule carries a **persisted capability manifest**
(`capabilities_json` on `cron_jobs`), consented to **once at schedule creation**:
`schedule_create` accepts a `capabilities` manifest, validates it against the same
forbidden/unknown checks `run_workflow` applies, and — if it grants side effects —
arms the threshold-aware approval at creation time. Both firing paths (the
scheduler's auto-fire and the run-now `POST /v1/schedules/:id/run` route) execute
the run under that stored manifest. Legacy or null-manifest schedules fall back to
the read-only baseline. The trigger records success once the run starts;
completion/failure is surfaced out-of-band via workflow events and the completion
wake.

---

## Tools, routes, and CLI

### Tools (served by the `workflows` skill)

Reached via the skill (`skill_load` then `skill_execute`), not as always-on tools.

- **`run_workflow`** — `{ script?, name?, args?, capabilities?, label? }` (exactly
  one of `script`/`name`). Returns `{ runId }` immediately; the run is
  asynchronous and you are notified in the conversation when it completes. **Do
  not poll.**
- **`manage_workflows`** — `{ action: "status" | "abort" | "resume" | "list_runs"
| "list_profiles", run_id? }`. `status`/`abort`/`resume` require `run_id`.
  `list_profiles` returns `{ profiles, activeProfile }` — the defined LLM profile
  names plus the workspace active profile, used to pick a valid leaf `profile`.

### Routes (read/abort/resume)

| Method | Path                            | Purpose                                                                                              |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/workflows`                 | List saved (named) workflows.                                                                        |
| `GET`  | `/v1/workflows/runs`            | List recent runs (newest first); `?limit`, `?status`.                                                |
| `GET`  | `/v1/workflows/runs/:id`        | Get one run.                                                                                         |
| `POST` | `/v1/workflows/runs/:id/abort`  | Signal an in-flight run to abort.                                                                    |
| `POST` | `/v1/workflows/runs/:id/resume` | Resume an interrupted run (refuses a side-effecting run in normal posture; proceeds at full access). |

### CLI

```
vellum workflows list              # saved (named) workflows
vellum workflows runs              # recent runs  (--limit, --status)
vellum workflows show <run-id>     # one run's status + counts
vellum workflows abort <run-id>    # abort an in-flight run
vellum workflows resume <run-id>   # resume an interrupted run
```

All subcommands accept `--assistant <name>` to target a specific instance.

---

## Configuration

Engine caps live under `workflows.*` in assistant config:

| Key                    | Default | Meaning                                                       |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `maxAgentsPerRun`      | 500     | Total leaves a single run may spawn (the runaway guard).      |
| `maxConcurrentLeaves`  | 6       | Max leaves in flight within one run.                          |
| `maxConcurrentRuns`    | 3       | Max workflow runs in flight at once.                          |
| `journalRetentionDays` | 30      | How long finished runs' journals are retained before pruning. |

---

## Persistence and resume

Run state lives in two tables (migration 284):

- **`workflow_runs`** — one row per run: status (`running` / `completed` /
  `failed` / `aborted` / `cap_exceeded` / `interrupted`), agent/token counts,
  script source + hash, capability manifest, and the originating conversation.
- **`workflow_journal`** — append-only `(run_id, seq)` log of every leaf call.

Leaf cost is attributed in `llm_usage_events` under `call_site = 'workflowLeaf'`,
so a run's spend is queryable after the fact.

On resume (re-invoking the same `runId`), a journal entry whose `(run_id, seq)`
and input hash match a completed prior call is replayed from cache without
re-spawning the leaf — the longest-unchanged-prefix replays, and only changed or
not-yet-run leaves execute.

### Recovering a crashed run

Resume is **not automatic**. If the assistant restarts mid-run, the run row is
left `running`; at startup the assistant reconciles every such orphaned row to
`interrupted` (status only — the agent/token accounting is preserved so the agent
cap still carries across the restart). An `interrupted` run sits there until you
explicitly resume it:

- **From the assistant**: `manage_workflows` with `action: "resume"` and the
  `run_id`.
- **From the CLI**: `vellum workflows resume <run-id>`.

Resuming re-invokes the engine with the same `runId`: it replays the completed
prefix from the journal and continues from the first unfinished leaf, under the
run's originally-declared capabilities and the same structural agent cap. Only
`interrupted` runs are resumable; a `completed` / `failed` / `aborted` run is
terminal.
