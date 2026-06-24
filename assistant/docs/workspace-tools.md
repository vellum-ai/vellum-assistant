# Workspace Tool Overrides

Workspace tool overrides let the operator replace a core assistant tool (or
add a brand-new one) by dropping a single file under their
`<workspaceDir>/tools/` directory. The override survives assistant restarts,
takes effect during the same startup phase as core tool initialization,
and is recoverable: removing the file restores the original core behavior.
Overrides are reconciled from disk on every conversation read, so edits
under `tools/` take effect on the next conversation with no restart and no
filesystem watcher.

This page explains the file convention, lifecycle position, and the
"single canonical source per name" invariant the design is built around.

## File convention

```
<workspaceDir>/
  tools/
    skill_load.ts        ← name="skill_load" via .ts default export
    my_tool.js           ← name="my_tool" via compiled .js
    data_lookup.json     ← name="data_lookup" via JSON spec
    host_bash.removed    ← name="host_bash" — strip from registry
```

Rules:

- The **filename stem** is the registered tool name verbatim. There is no
  derivation, no basename transformation, no directory layer.
- The loader looks for `.js` first, then `.ts`, then `.json`. The
  `.js`-preferred ordering matches compiled-binary semantics: a release
  build that ships compiled artifacts next to source runs the compiled
  file.
- `.json` files load as declarative specs — they describe schema and
  metadata but cannot supply an `execute` function. Calling a
  JSON-sourced tool returns an `isError` result; they exist for stubs
  and override placeholders.
- A `<name>.removed` sentinel file (any contents, typically empty)
  strips the same-named core tool from the registry without
  substituting a replacement. Removing the sentinel file restores the
  core tool on the next reconcile.
- Filename stems must satisfy `isProviderSafeToolName`
  (`/^[a-zA-Z0-9_-]{1,64}$/`). A stem with spaces or punctuation is
  logged at error and skipped; the loader never silently rewrites the
  name with a hash suffix that would be unfindable.
- Stems starting with `.` are skipped (so `.gitignore`, `.DS_Store`
  cannot accidentally register a tool).
- If `<name>.ts` and `<name>.js` (or any other shadow combination)
  coexist for the same stem, the winning extension is used and the
  shadowed siblings are logged at warn.

## Tool file shape

The default export is a generic `ToolDefinition` — the same shape every
tool surface in the assistant uses. All four normally-required fields
fall back to documented defaults if omitted, so a misconfigured tool
still loads cleanly and surfaces its problem at call time rather than
blocking assistant boot.

```ts
// /workspace/tools/skill_load.ts
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@vellumai/plugin-api";

const tool: ToolDefinition = {
  description: "Skill loader (custom workspace implementation)",
  defaultRiskLevel: "low",
  input_schema: {
    type: "object",
    properties: { skill_id: { type: "string" } },
    required: ["skill_id"],
  },
  async execute(
    input: { skill_id: string },
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    return { content: `loaded ${input.skill_id}`, isError: false };
  },
};

export default tool;
```

Defaults applied when fields are omitted:

| Field              | Default                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `description`      | `""`                                                                                        |
| `defaultRiskLevel` | `"high"`                                                                                    |
| `executionTarget`  | `"sandbox"`                                                                                 |
| `input_schema`     | `{ type: "object", properties: {}, additionalProperties: false }`                           |
| `execute`          | Returns `{ content: "workspace tool <name> has no execute implementation", isError: true }` |

## Override semantics

Workspace tools are the highest-priority origin in the tool registry:

- **Same name as a core tool** → the original core tool is moved into an
  internal stash (`getCoreToolOverride(name)`) and the workspace tool takes
  its place. Removing the workspace file restores the original on the next
  reconcile — workspace tools are not destructive to the core baseline.
- **Brand-new name** → registers as a net-new entry. No stash.
- **`<name>.removed` sentinel for a core tool** → the core tool is
  stripped (stashed in the same map as override-style stashing) and no
  replacement is registered. Deleting the sentinel restores the core
  tool. Stripping a name that doesn't exist is a logged no-op.
- **Collision with a skill / plugin / MCP tool of the same name** → the
  workspace registration throws. Workspace tools must register before
  other extension categories; seeing one of these owners during a
  workspace registration means the assistant startup order regressed.

Subsequent (post-workspace-load) registrations from plugins, skills, or
MCP servers that try to claim a name a workspace tool already owns (or
has stripped via `.removed`) are **warn-and-skipped**. Plugins, skills,
and MCP servers cannot bypass this by registering before workspace
tools load — the lifecycle pins workspace tools to register first.

Skill / plugin / MCP collisions with a workspace tool name across the
distinct namespacing those surfaces enforce are impossible — each runs
in its own owner-scoped registry path, and the workspace registration's
stamping is authoritative regardless of pre-existing ownership fields
on the incoming tool.

## Lifecycle position

```
initializeTools()             # core tools register
  → loadWorkspaceTools()      # initial workspace tool reconcile
    → MCP tool registration
    → loadUserPlugins()
    → bootstrapPlugins()

# on every conversation turn (createResolveToolsCallback):
resolveTools(history)
  → loadWorkspaceTools()                # reconcile registry against disk (fire-and-forget)
  → getWorkspaceToolDefinitions()       # re-read workspace tools from the registry
  → getMcpToolDefinitions()             # re-read MCP tools (same pattern)
```

Workspace tools register _after_ core tools and _before_ every other
extension surface during the initial reconcile so that every subsequent
registration sees the workspace tool as already-owned. The initial
reconcile always runs at boot, so workspace tools load from disk at every
startup.

There is no filesystem watcher. Instead, `loadWorkspaceTools()` is
idempotent and is re-invoked by the per-turn tool resolver
(`createResolveToolsCallback`), which then re-reads workspace tools from
the registry the same way it re-reads MCP tools. Each reconcile re-derives
the world from disk ("given what's on disk right now under `tools/`, what
registry state should the assistant be in?") and applies the delta —
registering added files, re-importing changed files, unregistering deleted
files, and restoring core tools whose `.removed` sentinel was deleted. A
conversation therefore picks up on-disk edits on its next turn, with no
restart and without being recreated.

The reconcile is fire-and-forget and eventually consistent: an edit lands
in the registry during one turn's reconcile and is read on a subsequent
turn. Unchanged files are skipped via an mtime cache, so a no-op reconcile
costs one `readdir` plus a `stat` per file and never re-imports. Concurrent
callers coalesce onto a single in-flight reconcile so their
unregister/register sequences never interleave. This is the same
eventual-consistency, re-derive-from-disk approach the plugin loader's
mtime cache uses, with the per-turn tool read — rather than a watcher —
kicking the reconcile.

## Per-tool isolation

A single broken workspace tool must never block assistant boot. The
loader applies the same per-tool isolation contract as the user-plugin
loader:

- A `.ts` / `.js` whose module body throws during import is logged at
  error and skipped — the loader proceeds to the next file.
- A `.ts` / `.js` whose default export is missing or not an object is
  logged at error and skipped.
- A `.json` that doesn't parse, or doesn't decode to an object, is
  logged at error and skipped.
- A `.ts` / `.js` whose module evaluation hangs is bounded by a
  10-second timeout. The abandoned import continues running in the
  background but the loader has already moved on. Bun's `import()`
  cannot be cancelled, so the registry guards against late-arriving
  registrations by the time-bounded path.

The registry's batch validation runs ahead of any mutation, so a single
late-discovered conflict (e.g. duplicate name within the batch) aborts
the whole call without partially populating the registry.

## Unregistering

Deleting `<workspaceDir>/tools/<name>.{ts,js,json}` is picked up by the
next reconcile, which calls `unregisterWorkspaceTool(name)` and restores
the stashed core tool when one exists, or simply deletes the entry when
the workspace tool was net-new. The change takes effect on the next
conversation — no assistant restart is required.

To strip a core tool without substituting a replacement, drop an empty
`<workspaceDir>/tools/<name>.removed` file. Removing that sentinel
restores the core tool on the next reconcile. The two states (override
vs. strip) are mutually exclusive — placing both `<name>.ts` and
`<name>.removed` for the same stem causes the reconcile to tear down
both states until the conflict is resolved on disk.
