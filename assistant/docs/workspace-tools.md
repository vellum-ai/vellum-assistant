# Workspace Tool Overrides

Workspace tool overrides let the operator replace a core assistant tool (or
add a brand-new one) by dropping a single file under their
`<workspaceDir>/tools/` directory. The override survives assistant restarts,
takes effect during the same startup phase as core tool initialization,
and is recoverable: removing the file restores the original core behavior.
When the `workspace-tools-watcher` feature flag is enabled, overrides are
also hot-reloaded by a filesystem watcher (no restart required after the
initial boot).

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
  its place. Removing the workspace file causes the watcher to restore
  the original — workspace tools are not destructive to the core baseline.
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
  → loadWorkspaceTools()      # initial workspace tool scan
    → MCP tool registration
    → loadUserPlugins()
    → bootstrapPlugins()

# after providers-setup completes:
DaemonServer.start()
  → WorkspaceToolsWatcher.getInstance().start()   # hot register/unregister via fs.watch
```

Workspace tools register _after_ core tools and _before_ every other
extension surface during the initial scan so that every subsequent
registration sees the workspace tool as already-owned. The initial scan
(`loadWorkspaceTools()`) always runs, so workspace tools load from disk
at every boot regardless of the flag.

The filesystem watcher is gated on the `workspace-tools-watcher` feature
flag (default off). When enabled, it runs for the lifetime of the
assistant, picking up add/change/delete events on `<workspaceDir>/tools/`
and reconciling the registry without requiring a restart. When disabled,
no watch loop is mounted and live edits to `<workspaceDir>/tools/` take
effect only on the next daemon restart. The flag is read at startup, so
toggling it takes effect on restart rather than mid-process.

The watcher debounces per filename stem and reconciles by re-deriving
the world from disk ("given what's on disk right now for `<stem>.*`,
what registry state should the assistant be in?") rather than routing
on `fs.watch`'s unreliable add/change/rename event types. This is the
same eventual-consistency pattern the plugin source watcher uses.

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

Deleting `<workspaceDir>/tools/<name>.{ts,js,json}` triggers the file
watcher's reconcile, which calls `unregisterWorkspaceTool(name)` and
restores the stashed core tool when one exists, or simply deletes the
entry when the workspace tool was net-new. No assistant restart is
required.

To strip a core tool without substituting a replacement, drop an empty
`<workspaceDir>/tools/<name>.removed` file. Removing that sentinel
restores the core tool on the next reconcile. The two states (override
vs. strip) are mutually exclusive — placing both `<name>.ts` and
`<name>.removed` for the same stem causes the watcher to tear down
both states until the conflict is resolved on disk.
