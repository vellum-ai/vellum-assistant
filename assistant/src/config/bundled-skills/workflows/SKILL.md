---
name: workflows
description: Delegate a big or high-stakes job to a fleet of parallel subagents, orchestrated deterministically; runs unattended and reports back
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "⚙️"
  vellum:
    display-name: "Workflows"
    category: "system"
    always-candidate: true
    activation-hints:
      - "Batch — apply one operation to each of MANY items (score / rate / rank / classify / extract / summarize each of a large set)"
      - "Comprehensive coverage — exhaustively sweep, audit, or find EVERY instance across a large surface"
      - "Research & synthesize — gather across many sources or pages and combine into one answer"
      - "Confidence — generate several independent attempts and judge them, or adversarially verify findings before trusting the result"
      - "Scale — work too large to finish well in one inline pass"
    avoid-when:
      - "A single inline answer, a quick lookup, or a small one-off"
      - "Interactive, conversational back-and-forth rather than unattended fan-out"
---

A workflow is a short JS/TS script you author that runs in a sandbox and fans work
out across many short-lived **leaf agents**, orchestrated deterministically. Launch
one with `run_workflow` (inline `script` OR saved `name`, exactly one). It returns a
`runId` immediately; the run is asynchronous and you are notified in this
conversation when it completes — **do NOT poll**.

Reach for one when a job is too big, too parallel, or too important for one inline
pass. That is more than batch/map-reduce over many items — it also covers exhaustively
sweeping or auditing a large surface, researching across many sources and synthesizing,
and generating several independent attempts to judge or adversarially verify before
trusting the result. For a single task or a quick lookup, do it inline.

## The script model

These are the load-bearing invariants. Get them wrong and the run misbehaves silently.

### Scripts are SYNCHRONOUS — never `await`

Host functions block and return their result directly. Write straight-line code.

```js
const r = agent("Summarize this thread."); // r is the result, right here
```

Do **not** write `await agent(...)`, and do **not** make the script `async`. An
`async` script deadlocks on its second host call — the sandbox can suspend the main
evaluation stack but not a promise continuation.

### Every script begins with a literal `meta`

The first statement must be a pure-literal export — no computed values, template
strings, or concatenation:

```js
export const meta = {
  name: "triage-inbox",
  description: "Triage and label inbox messages",
};
```

`meta` is extracted **statically**, without executing the script, so it must be a
plain object literal with string `name` and `description`. The `name` is how a saved
workflow is referenced by `workflow(name)` and the scheduler.

### You must `return` the result

The script body runs as a function. Its result is whatever it `return`s at the top
level — a bare trailing expression (e.g. `result;`) is **discarded** and the run
finishes with no result. Always `return` the value you want surfaced.

```js
const result = agent(`Write the final summary: ${JSON.stringify(parts)}`);
return result;
```

### Determinism (this is what makes runs resumable)

Every leaf call is journaled by sequence number and input hash, so a resumed run can
replay the unchanged prefix instead of re-spawning agents. That only holds if the
script is deterministic, so `Date.now()`, `Math.random()`, and argless `new Date()`
**throw**. Pass any timestamps or random seeds in through `args`.

## Host API

All functions are synchronous from the script's perspective.

| Function                     | Returns                                        | Notes                                                                                                       |
| ---------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `agent(prompt, opts?)`       | the leaf's result                              | Runs ONE leaf. **Throws** on leaf failure (fails the whole run).                                            |
| `leaf(prompt, opts?)`        | a leaf descriptor                              | Runs nothing on its own; used inside `parallel`/`map`/`pipeline`.                                           |
| `parallel(specs)`            | `results[]`                                    | Runs an array of `leaf(...)` descriptors concurrently, results in input order. A failed leaf becomes `null` (never throws). |
| `map(items, build)`          | `results[]`                                    | `build(item, i)` returns a `leaf(...)` descriptor per item; runs them like `parallel`.                     |
| `pipeline(items, ...stages)` | `results[]`                                    | Each `stage(prev, i)` returns a `leaf(...)` descriptor (run an agent) OR a plain value (pass through unchanged — filter/transform locally, no agent spent). Per-stage barrier: stage N+1 starts only after all of stage N finishes. |
| `phase(title)`               | —                                              | Marks a named phase for progress reporting.                                                                |
| `log(msg)`                   | —                                              | Emits a progress log line.                                                                                  |
| `usage()`                    | `{ agentsSpawned, inputTokens, outputTokens }` | Live snapshot so a script can self-moderate.                                                               |
| `workflow(name, args?)`      | the child's result                             | Runs a SAVED workflow inline, depth 1 only (a child may not call `workflow()`).                            |
| `args`                       | the run input                                  | The `args` object passed to `run_workflow`.                                                                |

Use `agent` for a single sequential leaf (throws on failure). Use `parallel`/`map`/
`pipeline` for fan-out (a failed leaf is `null`, so a batch survives a few bad items).

## Leaf options (`opts` for `agent` / `leaf`)

| Option    | Type                       | Effect                                                                                  |
| --------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `schema`  | JSON Schema object literal | Forces structured output via a tool. A schema leaf runs with **no tools** — no `file_read`/`file_list`/`recall`/`web_search`, so it **cannot read files or recall memory** (pure judge/extractor). Pass anything it must judge **inline** in the prompt; a schema leaf told to "read these files" answers from the model's prior, not real data. Use a plain JSON Schema literal, not Zod. |
| `label`   | string                     | Short display/diagnostic label for the leaf.                                            |
| `profile` | string                     | Overrides the model profile. Must exist in `llm.profiles` or the leaf throws. See [Listing profiles](#listing-available-profiles). |
| `persona` | boolean                    | `true` makes the leaf speak AS the assistant (identity + memory) — use for output meant to be in the assistant's voice. Default is anonymous — use for impartial judging/extraction. |

`persona: true` is the costly path (it runs the full memory-injection pipeline). Use
it only for the few leaves whose output must be in the assistant's voice; keep bulk
judging/extraction anonymous.

## Capabilities — the single consent point

The `capabilities` argument to `run_workflow` declares **once**, up front, what the
run's leaves may do. There are **no per-call permission prompts inside a running
workflow**.

```jsonc
{
  "tools": ["file_write", "gmail_send"], // side-effecting tools granted to leaves
  "hostFunctions": [],                    // host-function names the run may invoke
  "persona": true                         // grant leaves persona (identity + memory)
}
```

- **Read-only baseline** (available to **tool** leaves, no declaration, no launch prompt):
  `file_read`, `file_list`, `recall`, `web_search`. **A schema leaf gets none of these**
  (it runs as a single forced-tool-choice call) — pass it inline content, never tell it to read.
- **`web_fetch` is NOT in the baseline** — an outbound fetch is side-effecting (its
  URL can exfiltrate read data), so a leaf that must fetch a URL has to declare
  `"web_fetch"` in `capabilities.tools`.
- **Declaring ANY side-effecting tool** (writes, sends, shell, `web_fetch`, …) or
  host function makes the LAUNCH prompt the user for approval **once** — that single
  approval covers the whole run. A read-only run (no declared tools) launches with no
  prompt. Declare the minimum you need.

Runs are autonomous but BOUNDED by a per-run agent cap — spend is structurally
capped and you cannot exceed it.

## Listing available profiles

Before choosing a `profile` for a leaf, look up the valid values rather than guessing
— an unknown profile throws.

- **Preferred (model-accessible):** call `manage_workflows` with action
  `list_profiles`. It returns the profile names defined in `llm.profiles` plus the
  workspace-wide active profile.
- The same data is served by the daemon route `GET config/llm/profiles` (operationId
  `llm_profiles_list`), which clients use to populate profile dropdowns.

Omit `profile` to use the default: a persona leaf mirrors the main agent (the active
profile floats above the call-site default); an anonymous leaf uses the cost-optimized
`workflowLeaf` default.

## Run management

Use `manage_workflows` to inspect and control runs:

| Action          | Requires   | Purpose                                                          |
| --------------- | ---------- | ---------------------------------------------------------------- |
| `status`        | `run_id`   | Status + agent/token counts for one run (NOT the result).       |
| `get_result`    | `run_id`   | The full result of a finished run.                              |
| `list_runs`     | —          | Recent runs, newest first.                                      |
| `abort`         | `run_id`   | Signal an in-flight run to abort.                               |
| `resume`        | `run_id`   | Resume an `interrupted` run (see below).                        |
| `list_profiles` | —          | List defined profiles + the active profile (for leaf `profile`).|

The completion notification injected when a run finishes carries a **truncated**
preview of the result (large results are cut off). To read the complete result,
call `manage_workflows` with action `get_result` and the `run_id` — `status`
deliberately omits the result to stay lightweight.

### Crash recovery / resume

Resume is **not automatic**. If the assistant restarts mid-run, the run is reconciled
to status `interrupted` (the agent/token accounting is preserved so the agent cap
still carries across the restart). It sits there until you explicitly resume it by
`run_id` via `manage_workflows` action `resume`. Resuming re-invokes the engine with
the same `runId`: the journal **replays the completed prefix** without re-spawning (or
re-paying for) finished leaves, then continues from the first unfinished leaf under the
run's originally-declared capabilities. Only `interrupted` runs are resumable; a
`completed` / `failed` / `aborted` run is terminal.

## Worked example

Score each inbox item in parallel (anonymous schema leaves), then write one summary in
the assistant's voice (a single persona leaf). The item list comes in via `args` —
never fetched inside the script.

```js
export const meta = {
  name: "triage-inbox",
  description: "Score and summarize inbox items",
};

phase("score");
const scored = map(args.items, (item) =>
  leaf(`Rate this message's urgency 0-10 with a one-line reason:\n${item.subject}\n${item.body}`, {
    label: `score:${item.id}`,
    schema: {
      type: "object",
      properties: { urgency: { type: "number" }, reason: { type: "string" } },
      required: ["urgency", "reason"],
    },
  }),
);

phase("summarize");
const summary = agent(
  `Here are scored inbox items. Write a short triage summary, highlighting anything urgent:\n${JSON.stringify(scored)}`,
  { persona: true },
);
return summary;
```

A failed scoring leaf shows up as `null` in `scored`; the run continues.
