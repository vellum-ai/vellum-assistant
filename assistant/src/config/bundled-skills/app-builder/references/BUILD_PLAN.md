# Build Plan Artifact

The planner (running on the quality tier) writes a single build plan to `/workspace/data/apps/<slug>/PLAN.md` before any worker writes code. The plan is the contract: balanced-tier `coder` workers each implement a disjoint slice of it in parallel, the parent compiles ONCE, and a repair subagent reads it on failure. A worker should be able to execute its row of the file-partition table without seeing the original user request.

Write the plan with `file_write` to `/workspace/data/apps/<slug>/PLAN.md` (inside the sandbox, so `file_write`, not `host_file_read`). Write it ONCE, fully, before dispatching workers.

---

## Required sections

A plan has exactly these five sections, in this order.

### 1. Data schema

The JSON Schema for one record — the same artifact passed to `app_create`'s `schema_json` (see SKILL.md Step 2). Define only user-facing fields; the system adds `id`, `appId`, `createdAt`, `updatedAt`. Keep it flat: `string` / `number` / `boolean`, with `enum` for closed sets and a `required` array. Apps without persistence (calculators, landing pages, slide decks) state "No persistence — ephemeral UI state only" here instead.

### 2. Visual direction

This is the single source of truth every worker reads to stay visually consistent. It is sourced from the `frontend-design` skill (aesthetic judgment) and `{baseDir}/references/DESIGN_SYSTEM.md` (concrete tokens). Pin all four of:

- **Palette** — the chosen aesthetic direction (one of `frontend-design`'s extremes: editorial, brutalist, luxury, organic, etc.) expressed as **exact** token assignments. Map the build's accent and surface choices onto `--v-*` tokens: `--v-accent` / `--v-accent-hover`, `--v-bg` / `--v-surface` / `--v-surface-border`, and which `--v-{slate,emerald,violet,indigo,rose,amber}-*` palette ramp backs them. Status colors use `--v-success` / `--v-danger` / `--v-warning`. Text on filled/accent backgrounds is `--v-aux-white`; text on surfaces is `--v-text` / `--v-text-secondary` / `--v-text-muted`. Never name a raw hex — name the token. If the build uses a fully custom branded theme (hardcoded hex + `@media (prefers-color-scheme: dark)`), say so explicitly here and list the hex pairs once, so workers don't mix custom hex with auto-switching `--v-*` on the same element.
- **Typography** — the scale, in tokens: `--v-font-family` / `--v-font-mono`, and which size steps (`--v-font-size-xs` 10px → `-2xl` 26px) map to which roles (display, heading, body, caption). Note the body default for the target interface (17px mobile-first `ios`, 14px desktop-first `macos` / `web`).
- **Motion** — durations in tokens (`--v-duration-fast` 0.15s / `-standard` 0.25s / `-slow` 0.4s) and the high-impact moments they back (one orchestrated page-load with staggered `animation-delay`, hover affordances behind `@media (hover: hover)`).
- **Atmosphere** — the background and depth treatment (gradient mesh, noise/grain, layered transparency, dramatic shadows via `--v-shadow-sm/md/lg`) that gives the app its identity rather than a flat fill.

### 3. Component tree

The Preact component hierarchy, as a tree. Each node names the component file and its responsibility in a few words. This is the map the partition table slices.

### 4. File partition table

The orchestration core: **one row per worker**, listing the exact file paths that worker owns, a one-line purpose per file, and the key props each component takes. Every source file in the build appears in **exactly one** row. Use this shape:

| Worker | Files (disjoint) | Purpose | Key props |
| ------ | ---------------- | ------- | --------- |

Paths are absolute under the app: `/workspace/data/apps/<slug>/src/...`. A worker that owns a leaf component also owns nothing else; the parent or a designated worker owns shared files (`styles.css`, `types.ts`, `main.tsx`, `index.html`).

---

## Hard invariants

The parallel orchestration is only correct if these hold. The planner MUST guarantee them when authoring the partition table; workers MUST respect them at execution time.

1. **Partitions are disjoint.** No file path appears in two rows. Two workers writing the same file race and clobber each other — the build is non-deterministic and usually broken. If two components are too coupled to split cleanly, put them in the same worker's row, not in two rows.
2. **Shared files have exactly one owner.** `styles.css` and any shared design-token file are written by exactly one worker (or pre-seeded by the parent in the `app_create` scaffold and then owned by no worker). Every other worker that needs a class consumes it from the agreed token names in the Visual direction section — it does not redefine or re-emit `styles.css`. `types.ts`, `main.tsx`, and `index.html` likewise each have a single owner.
3. **Workers NEVER compile.** Only the parent calls `app_refresh`, and it calls it ONCE, after every worker has finished writing its files. A worker that calls `app_refresh` (or `app_create`, or `app_open`) breaks the single-compile contract and corrupts the shared build cache. Workers use `file_write` / `file_edit` only, strictly within the paths in their own row.

---

## Verbatim example

A filled-in plan for a project tracker. A worker assigned a row below could execute it directly.

````markdown
# Build Plan — Project Tracker (slug: project-tracker)

## 1. Data schema

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "status": {
      "type": "string",
      "enum": ["backlog", "in-progress", "review", "done"]
    },
    "priority": {
      "type": "string",
      "enum": ["low", "medium", "high", "critical"]
    },
    "tags": { "type": "string" },
    "notes": { "type": "string" }
  },
  "required": ["title", "status"]
}
```

## 2. Visual direction

Aesthetic: **refined editorial**, calm and precise — a boutique studio's internal tool. Desktop-first (`interface: web`).

- **Palette** — backed by the `--v-indigo-*` ramp.
  - `--v-accent` = indigo-600, `--v-accent-hover` = indigo-700.
  - `--v-bg` = slate-950 base with the atmosphere layer on top; `--v-surface` = slate-900; `--v-surface-border` = slate-800.
  - Status: `backlog` → `--v-text-muted`, `in-progress` → `--v-accent`, `review` → `--v-warning`, `done` → `--v-success`. `critical` priority → `--v-danger`.
  - Text on the indigo accent (badges, primary button) = `--v-aux-white`. Text on surfaces = `--v-text` (titles) / `--v-text-secondary` (meta) / `--v-text-muted` (empty/disabled). No raw hex anywhere.
- **Typography** — `--v-font-family` throughout, `--v-font-mono` for the priority/ID chips.
  - Display (board column headers): `--v-font-size-xl` (22px), weight 600.
  - Heading (card title): `--v-font-size-lg` (17px), weight 600.
  - Body default: `--v-font-size-base` (14px), desktop-first.
  - Caption (tags, timestamps): `--v-font-size-sm` (11px), `--v-text-muted`.
- **Motion** — `--v-duration-fast` (0.15s) on hover lift and button states; `--v-duration-standard` (0.25s) on card enter and column reflow. One orchestrated page load: columns fade+rise with staggered `animation-delay` (0ms / 60ms / 120ms / 180ms). Hover lift gated behind `@media (hover: hover)`.
- **Atmosphere** — fixed full-viewport background: a subtle indigo→slate radial gradient mesh off the top-left, plus a 3% grain overlay. Cards sit on `--v-surface` with `--v-shadow-md`, lifting to `--v-shadow-lg` on hover. Not a flat fill.

## 3. Component tree

```
App                      — board shell, owns records state + fetch
├─ Header                — title, record count, "New" button
├─ Board                 — 4 status columns, drag-to-reorder
│  └─ Column (×4)        — one status lane, renders its cards
│     └─ Card            — single record: title, priority chip, tags
├─ RecordForm           — create/edit modal (side modal, desktop-first)
└─ EmptyState           — designed empty board (.v-empty-state)
```

## 4. File partition table

| Worker                                    | Files (disjoint)                                                     | Purpose                                                                                           | Key props                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **W1 — shell & data (owns shared files)** | `/workspace/data/apps/project-tracker/src/components/App.tsx`        | Board shell; loads records via `window.vellum.fetch`, holds state, passes records + handlers down | — (root)                                                                         |
|                                           | `/workspace/data/apps/project-tracker/src/main.tsx`                  | Entry; renders `<App/>` into `#app`                                                               | —                                                                                |
|                                           | `/workspace/data/apps/project-tracker/src/types.ts`                  | Shared `Record`, `Status`, `Priority` types                                                       | —                                                                                |
|                                           | `/workspace/data/apps/project-tracker/src/styles.css`                | **Sole owner.** Tokens, atmosphere background, card/column/badge classes from §2                  | —                                                                                |
| **W2 — header & form**                    | `/workspace/data/apps/project-tracker/src/components/Header.tsx`     | Title, live record count, "New" button                                                            | `count: number`, `onNew: () => void`                                             |
|                                           | `/workspace/data/apps/project-tracker/src/components/RecordForm.tsx` | Create/edit side modal; validates before submit, toast on save                                    | `record?: Record`, `onSave: (r: Record) => Promise<void>`, `onClose: () => void` |
| **W3 — board & columns**                  | `/workspace/data/apps/project-tracker/src/components/Board.tsx`      | 4 status columns, staggered page-load reveal, drag-to-reorder                                     | `records: Record[]`, `onMove: (id, status) => void`, `onEdit: (r) => void`       |
|                                           | `/workspace/data/apps/project-tracker/src/components/Column.tsx`     | One status lane; renders its cards, accepts drops                                                 | `status: Status`, `records: Record[]`, `onEdit: (r) => void`                     |
| **W4 — card & empty state**               | `/workspace/data/apps/project-tracker/src/components/Card.tsx`       | Single record: title, mono priority chip, tag pills, hover lift                                   | `record: Record`, `onEdit: (r) => void`                                          |
|                                           | `/workspace/data/apps/project-tracker/src/components/EmptyState.tsx` | Designed empty board with "New" CTA                                                               | `onNew: () => void`                                                              |

`src/index.html` is pre-seeded by the parent in the `app_create` scaffold and owned by no worker.

**Invariants for this build:** W1 is the sole writer of `styles.css` and `types.ts`; W2–W4 import the token names and types defined there and never re-emit them. No path repeats across rows. No worker calls `app_refresh` — the parent compiles once after W1–W4 all finish.
````
