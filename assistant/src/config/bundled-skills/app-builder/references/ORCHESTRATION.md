# Planner / Worker Orchestration

A non-trivial build runs as three tiers: a **planner** on the quality tier writes the plan, a wave of **coder** workers on the balanced tier each implement a disjoint slice in parallel, and the **parent** compiles ONCE and surfaces the result. This file is the exact spawn sequence. The paths and tool shapes here are fragile — follow them verbatim, don't paraphrase.

The contract for the plan artifact itself lives in `{baseDir}/references/BUILD_PLAN.md` (read with `host_file_read`). This file is the orchestration around it.

---

## The sequence

### (a) PLAN — planner @ quality

Run the planner on the quality tier, because partitioning a component tree into clean, disjoint, independently-buildable slices is judgment work. Either you (the parent) are already on the quality tier from Step 0 of SKILL.md, or you spawn a dedicated planner.

The planner:

1. Loads the `frontend-design` skill (aesthetic judgment) and reads `{baseDir}/references/DESIGN_SYSTEM.md` via `host_file_read` (concrete `--v-*` tokens).
2. Writes the build plan to `/workspace/data/apps/<slug>/PLAN.md` with `file_write`, ONCE, fully, following BUILD_PLAN.md's five-section shape.
3. Partitions the component tree into **disjoint file sets** — one row per worker in the §4 file-partition table, every source file in exactly one row.

The plan is the only thing workers read. A worker must be able to build its row without seeing the original user request.

### (b) DISPATCH — coder workers @ balanced, in bounded waves

Spawn one `coder` subagent per partition row with `subagent_spawn`. Route them to the `balanced` tier — writing a component against a fixed spec is mechanical, not judgment work, so the cheaper tier is correct here.

⚠️ **Spawns are uncapped. Cap them yourself.** Dispatch in bounded waves: **3 workers per wave for partitions of ≥7 files, 4 for ≤6.** A 9-file partition is bounded waves of 3, not nine simultaneous spawns. Wait for a wave to finish (step c) before starting the next.

**If a worker fails or times out →** re-spawn that row once on a fresh worker; if it fails again, fold its files into the repair scope (step e).

Each worker's `objective` carries **its partition slice plus the relevant excerpt of PLAN.md** — the §2 Visual direction (verbatim, every worker needs it), its own row of the §4 table, and the §3 component-tree context for its files. The worker reads PLAN.md from the sandbox if it needs more; the objective is the self-contained brief.

Verbatim spawn for a worker (matches the `subagent_spawn` schema — `label`, `objective`, `role`, `override_profile`):

```
subagent_spawn({
  label: "W3 — board & columns",
  role: "coder",
  override_profile: "balanced",
  objective: "Build two files for the app at /workspace/data/apps/project-tracker, and ONLY these two files:\n  - /workspace/data/apps/project-tracker/src/components/Board.tsx\n  - /workspace/data/apps/project-tracker/src/components/Column.tsx\n\nUse file_write only. Do NOT call app_refresh, app_create, or app_open — the parent compiles. Do NOT touch any other file.\n\nProps:\n  Board:  records: Record[], onMove: (id, status) => void, onEdit: (r) => void\n  Column: status: Status, records: Record[], onEdit: (r) => void\n\nVisual direction (the single source of truth — match it exactly):\n<paste §2 Visual direction from /workspace/data/apps/project-tracker/PLAN.md verbatim>\n\nImport shared types from ./types and shared classes from styles.css — they are owned by W1; do not redefine them."
})
```

### (c) COLLECT — completion notification + `subagent_read`

You are notified when each subagent completes — do NOT poll with `subagent_status`. On completion, read the worker's work product:

```
subagent_read({ label: "W3 — board & columns", last_n: 1 })
```

Confirm the worker wrote only its own files and reported success. When the whole wave is in, dispatch the next wave (b). When all waves are in, proceed to compile.

### (d) COMPILE — parent, ONCE

Only the parent compiles, and only after every worker across every wave has finished:

```
skill_load("app-builder")
app_refresh(app_id)
```

⚠️ **Workers NEVER compile.** `app_refresh` runs exactly once, here, from the parent. A worker that compiles corrupts the shared build cache and races the others.

### (e) REPAIR — repair subagent @ quality-optimized, bounded retries

If `app_refresh` returns compile errors, spawn a single repair subagent on the **quality-optimized** tier (fixing cross-file type and import errors is judgment work). Its objective carries the compile errors verbatim, the PLAN.md path, and the specific failing files.

Verbatim spawn for the repair agent:

```
subagent_spawn({
  label: "Repair — compile errors",
  role: "coder",
  override_profile: "quality-optimized",
  objective: "The app at /workspace/data/apps/project-tracker failed to compile. Fix it with file_edit. Do NOT call app_refresh — report when done and the parent recompiles.\n\nCompile errors:\n<paste the full app_refresh error output verbatim>\n\nThe build plan is at /workspace/data/apps/project-tracker/PLAN.md — read it for the intended types, props, and token names.\n\nFailing files:\n  - /workspace/data/apps/project-tracker/src/components/Board.tsx\n  - /workspace/data/apps/project-tracker/src/types.ts\n\nEdit only what's needed to clear the errors. Stay consistent with the plan's §2 Visual direction."
})
```

After the repair agent reports done, the parent runs `skill_load("app-builder")` + `app_refresh(app_id)` again. **Bound the loop to ≤2 repair attempts.** After the 2nd repair attempt fails → call `app_open(app_id, open_mode: "preview")` to surface the last good state, THEN post a chat message listing the failing files and unresolved errors. Do not loop indefinitely.

### (f) SURFACE — `app_open`

On a clean compile, render the inline preview card (SKILL.md Step 5):

```
skill_load("app-builder")
app_open(app_id, open_mode: "preview")
```

---

## Wrong vs right

❌ **Wrong — a worker compiles:**

```
subagent_spawn({
  label: "W3 — board",
  role: "coder",
  override_profile: "balanced",
  objective: "Build Board.tsx and Column.tsx, then call app_refresh to check it compiles."   // NO
})
```

The worker calling `app_refresh` breaks the compile-once contract, races the other workers, and corrupts the shared build cache.

✅ **Right — the worker writes files only; the parent compiles once after the whole wave:**

```
subagent_spawn({
  label: "W3 — board",
  role: "coder",
  override_profile: "balanced",
  objective: "Build Board.tsx and Column.tsx with file_write only. Do NOT call app_refresh — the parent compiles."
})
```

❌ **Wrong — overlapping partitions:**

```
W2 → src/components/Header.tsx, src/styles.css
W3 → src/components/Board.tsx, src/styles.css     // styles.css in two rows — workers race and clobber
```

✅ **Right — disjoint partitions, one owner per shared file:**

```
W1 → src/styles.css, src/types.ts   (sole owner of shared files)
W2 → src/components/Header.tsx
W3 → src/components/Board.tsx, src/components/Column.tsx
```

Every source file appears in exactly one row (BUILD_PLAN.md hard invariant 1). Shared files (`styles.css`, `types.ts`, `main.tsx`, `index.html`) have exactly one owner; everyone else consumes the agreed token names and types.

---

## Fallback — single-tier sequential build

The tiered sequence assumes the workspace has both a `balanced` and a `quality-optimized` profile. If it has neither (check with `assistant config get llm.profiles`), **degrade to a single-tier sequential build** rather than spawning workers on an unknown tier:

1. Skip the worker dispatch entirely. The parent (already on the best available profile from SKILL.md Step 0) writes every file itself, sequentially, with `file_write` — following the same PLAN.md, in partition-table order.
2. Compile ONCE with `app_refresh` (step d).
3. On compile failure, the parent fixes the errors inline with `file_edit` and recompiles, bounded to ≤2 attempts, then surfaces to the user (step e, no subagent).
4. Surface with `app_open` (step f).

If exactly one of the two profiles is missing, substitute the nearest available tier — use the highest-quality profile for the planner and repair agent, and the cheapest non-quality profile for workers — rather than dropping to the sequential fallback. The sequential fallback is only for when no profile routing is available at all.
