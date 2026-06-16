# Workflows — Manual e2e / Live-Verification Runbook

This runbook covers the parts of the workflow engine that automated tests do not:
real provider calls, real journaled resume across a restart, capability
containment under a live model, flag-off inertness, and persona-leaf voice. Unit
and integration coverage lives under `assistant/src/workflows/*.test.ts` and
`assistant/src/__tests__/`; this is the human-in-the-loop pass that runs **last**,
on throwaway instances first, and only touches a real inbox or a production
instance at the very end.

Work through the steps in order. The `workflows` flag is **off by default**, so
every step that exercises the engine first enables it on a throwaway instance.

> **Safety rule:** Nothing in this runbook touches a real inbox, a real workspace,
> or a production instance until every throwaway-instance step has passed. The
> production/persona instance is the **last** step.

---

## 1. Hatch a throwaway instance and enable the flag

Hatch a disposable Docker instance built from local source:

```
vellum hatch --remote docker --source .
```

Note the instance name it prints (e.g. `vellum-<adjective>-<animal>`). Use it as
`--assistant <name>` for everything below, or set it active.

Enable the `workflows` flag via that instance's feature-flag override file. The
override lives in the instance's `protected/feature-flags.json` (overrides here
win over the registry default — see the feature-flag-overrides gotcha):

```jsonc
// .../<instance>/protected/feature-flags.json
{ "workflows": true }
```

Restart the instance so it re-reads the override, then confirm it is up:

```
vellum ps
```

Sanity-check that the surface is now live: `vellum workflows runs --assistant <name>`
should return an (empty) table rather than a 404.

---

## 2. Synthetic-corpus run (no Gmail/Slack dependency)

Drive a `run_workflow` over a **fixture item list passed as `args`** — no external
integration. Ask the assistant (via `vellum events`-visible conversation, the app,
or a CLI message) to run a small workflow such as the triage example from
[`workflows.md`](./workflows.md), passing a dozen synthetic items in `args.items`.

Watch the run:

```
vellum workflows runs  --assistant <name>          # find the runId
vellum workflows show  <run-id> --assistant <name>  # status + agent/token counts
vellum events          --assistant <name>           # workflow_progress / workflow_completed
```

Confirm:

- The run reaches `completed`.
- `agentsSpawned` matches the number of leaves the script should have launched.
- A completion summary is injected back into the originating conversation.

---

## 3. Inspect the evidence

Query the instance's database directly (the live DB is under the instance's
`workspace/data/db/assistant.db`).

**Leaf cost attribution** — confirm leaves ran on the cost-optimized model and
tally spend:

```sql
SELECT model, COUNT(*) AS calls,
       SUM(input_tokens)  AS in_tok,
       SUM(output_tokens) AS out_tok,
       SUM(estimated_cost_usd) AS usd
FROM llm_usage_events
WHERE call_site = 'workflowLeaf'
GROUP BY model;
```

**Request shape** — confirm the schema path forced a tool and used a cheap model;
for persona leaves, confirm identity + memory were injected:

```sql
SELECT id, created_at
FROM llm_request_logs
ORDER BY created_at DESC
LIMIT 20;
```

Inspect a few `request_payload` bodies:

- A **schema** leaf request carries `tool_choice` forcing the synthetic
  `emit_result` tool and a cheap model id.
- A **persona** leaf request's system prompt carries the assistant identity and a
  `<memory>` block; an **anonymous** leaf's does not.

---

## 4. Restart-resume (journal replay)

Start a **long** synthetic run (enough leaves that it is still in flight for a few
seconds). While it is running, restart the assistant with **SIGTERM**:

> **Never SIGKILL the assistant.** SIGKILL leaves WAL pages unmerged and forces a
> costly recovery on the next start (and can corrupt an in-flight run). Use a
> graceful stop / `vellum sleep` / SIGTERM with grace.

After restart, the run that was in flight when the process stopped is no longer
`running` — at startup the assistant reconciles every orphaned `running` row to
`interrupted` (status only; the accounting counters are preserved). Resume is
**not automatic**. Confirm the run shows up as interrupted, then trigger an
explicit resume:

```bash
# The crashed run is now interrupted, not running.
vellum workflows runs --status interrupted

# Trigger the resume (or: manage_workflows with action="resume" from chat).
vellum workflows resume <run-id>
```

Resuming re-invokes the engine with the **same `runId`**, so the completed prefix
replays from the journal. Assert:

- Resuming does **not** double the `agentsSpawned` count or the
  `llm_usage_events` rows for `call_site = 'workflowLeaf'` — the completed prefix
  replays from the journal rather than re-spawning leaves. The agent count
  **carries** across the restart (it seeds from the persisted run row) instead of
  resetting to zero.
- Only leaves that had not completed before the restart produce new usage rows.
- The run transitions `interrupted` → `running` → a terminal status.

```sql
-- Before and after the resume, this count should not grow for already-done leaves.
SELECT COUNT(*) FROM llm_usage_events WHERE call_site = 'workflowLeaf';

-- The journal holds one row per completed (run_id, seq); resuming does not duplicate them.
SELECT run_id, COUNT(*) FROM workflow_journal GROUP BY run_id;
```

---

## 5. Capability containment

Author a workflow whose leaf tries to use a **side-effecting tool that is absent
from its manifest** (e.g. a leaf prompt that pushes the model toward `file_write`
or a send tool, with `capabilities.tools` left empty). Run it and confirm:

- The forbidden tool invocation is **hard-denied** inside the leaf — it never
  executes. The leaf gets an error result, not a permission prompt (there are no
  per-call prompts inside a run).
- Declaring a **forbidden** tool (`subagent_spawn`, `run_workflow`,
  `manage_workflows`, `manage_secure_command_tool`) in `capabilities.tools` fails
  the run synchronously at start — `run_workflow` returns an error and **no**
  `running` row is created.

---

## 6. Flag-off inertness

On a **default** instance (no `workflows` override, or set back to `false` and
restart), confirm the whole surface is gone:

- `run_workflow` and `manage_workflows` are **absent** from the tool set (the
  assistant cannot call them).
- The routes 404:

  ```
  vellum workflows runs --assistant <default-instance>   # request fails (404)
  ```

- A scheduler `workflow`-mode job is **rejected** (the engine gate throws before
  any run is launched).

---

## 7. Real-data smoke (throwaway TEST account)

Only after steps 1–6 pass: run the full path against a **throwaway TEST Google or
Slack account** with about a dozen messages — never a real account. Drive the
end-to-end flow:

1. The assistant enumerates the relevant skill (e.g. `gmail`).
2. It authors and launches a `run_workflow` over the real messages.
3. Leaves synthesize results.
4. Any side-effecting action (label, draft, reply) goes through the declared
   capability manifest and the normal audited-action path.

Confirm the run completes, the evidence queries from step 3 look right against
real content, and every side effect was one the manifest declared.

---

## 8. Production / persona instance — LAST

Flip the `workflows` flag on a real (e.g. persona) instance **only after** the
throwaway instances above pass, and only after the instance is on current code:

1. `git pull` and **restart** the instance so it runs the merged code (a restart
   alone re-runs stale code — see the deploy gotcha).
2. Enable the flag and restart.
3. Start with the **smallest real slice** — a few items, dry-run actions where the
   tool supports it — before any larger or side-effecting run.
4. **Human-eval the persona-leaf voice**: read a persona leaf's output and confirm
   it reads as the assistant, not as a generic worker.

Stop and reassess if any run's `agentsSpawned` approaches `maxAgentsPerRun`, if
spend (step 3 query) is higher than expected, or if any side effect was not one
the manifest declared.
