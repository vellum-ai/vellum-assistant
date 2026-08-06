# Skills

Bundle instructions, assets, and scripts the Assistant pulls in on demand. A skill teaches the Assistant a repeatable workflow it loads only when the situation calls for it.

A skill is a directory with a `SKILL.md` at its root. The file is YAML frontmatter followed by a markdown body: the frontmatter tells the Assistant what the skill is for, and the body is the instructions it follows once the skill is active. A plugin ships skills under `skills/<name>/`, and the skill catalog loader discovers them on disk.

## What a skill is

A skill is a bundle of instructions and supporting files that the Assistant loads into context when the conversation matches what the skill is for. Nothing runs on its own: the skill gives the Assistant a procedure to follow, plus any scripts or assets it ships alongside.

The Assistant decides when to load a skill from its `description` and activation hints, so write those fields for the model: say what the skill is for and the situations it should fire in.

## Frontmatter reference

These are the fields the `SKILL.md` frontmatter can set. Only `name` and `description` are required; everything under `metadata` is optional and refines how the skill is presented and matched.

| Field                              | Type       | Required | Description                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                             | `string`   | Yes      | Skill display name used in skill lists and matching. The canonical identifier is the directory basename (the folder name under `skills/`), not this field. Keep them aligned to avoid confusion, but note that the runtime uses the directory name for deduplication and collision resolution. |
| `description`                      | `string`   | Yes      | What the skill does and when to use it. The Assistant matches against this to decide whether to load the skill, so write it for the model, not for a human reader.                                                                                                                             |
| `metadata.emoji`                   | `string`   | No       | Glyph shown next to the skill in clients that render a skill list.                                                                                                                                                                                                                             |
| `metadata.vellum.display-name`     | `string`   | No       | Human-friendly label for the skill. Falls back to name when omitted.                                                                                                                                                                                                                           |
| `metadata.vellum.activation-hints` | `string[]` | No       | Plain-language situations where the skill should activate. These sharpen the match beyond the description.                                                                                                                                                                                     |
| `metadata.vellum.avoid-when`       | `string[]` | No       | Situations where the skill should not activate, used to keep it from firing on adjacent-but-wrong requests.                                                                                                                                                                                    |
| `metadata.vellum.category`         | `string`   | No       | Grouping used when the skill is listed in a client. Defaults to "system".                                                                                                                                                                                                                      |

## Resolution order

Skills are discovered at boot and loaded into the catalog in a fixed order. The model then pulls skills into context on demand: it matches the conversation against each skill's `description` and activation hints, then loads the ones that fit. Multiple skills can be active at the same time.

Discovery is filesystem-driven and happens before the first turn:

1. **Bundled skills.** Shipped with the Assistant, discovered from the built-in skills directory.
2. **Workspace skills.** Discovered from `/workspace/skills/`, letting you drop a skill directory without packaging it as a plugin.
3. **Plugin skills.** Discovered from every plugin's `skills/` subdirectory at boot.

When two skills with the same name are discovered, the first one found wins and the duplicate is logged and skipped. The load order above determines which skill wins a name collision; once loaded, there is no execution priority between skills. They are instruction bundles, not runnable hooks, and the model decides which to follow based on the frontmatter, not on timing.

## Anatomy of a skill

One skill per directory. The `SKILL.md` is required; assets and helper scripts are optional and live alongside it:

```
plugins/my-plugin/
└── skills/
    └── standup-notes/
        ├── SKILL.md        # Frontmatter + instructions (required)
        ├── TOOLS.json      # Optional skill-scoped tool manifest
        ├── references/     # Optional docs the instructions cite
        ├── scripts/        # Optional helper scripts the skill runs
        │   └── post_summary.ts
        └── tools/          # Executors for TOOLS.json entries
            └── save_note.ts
```

The `SKILL.md` itself is frontmatter plus the procedure the Assistant follows once the skill is active:

```yaml
---
name: standup-notes
description: >-
  Draft a daily standup update from recent activity. Use when the user
  asks for their standup, daily update, or what they did yesterday.
metadata:
  vellum:
    display-name: "Standup Notes"
    activation-hints:
      - "User asks for their standup or daily update"
    avoid-when:
      - "User wants a full weekly report, not a daily standup"
---

Draft a concise standup update with three sections: Yesterday, Today,
and Blockers.

## Steps

1. Summarize what was completed since the last standup.
2. List what the user plans to work on today.
3. Call out any blockers, or write "None" when there are none.

Keep each section to a few short bullet points.
```

### Referencing scripts and reference files from the body

The `scripts/` and `references/` directories are optional companions to `SKILL.md`. The body invokes them by relative path:

- **Scripts:** Reference a script by its path relative to the skill directory. The assistant runs it via the `bash` tool when the instructions call for it. For example, a body that says "Run `scripts/post_summary.ts` to submit the summary" tells the assistant to execute `bun run scripts/post_summary.ts` from the skill directory.
- **References:** Cite a reference file by relative path when the body needs to defer detail. For example, "See `references/api-fields.md` for the full field contract" tells the assistant to read that file when it needs the details, rather than inlining them in the body. This keeps the body short and loads the detail only when relevant.

## Skill-scoped tools (`TOOLS.json`)

A skill can carry real, schema-validated tools that exist only while the skill is active — unlike `tools/<name>.ts` plugin tools, which sit on every conversation's catalog on every turn (see [tools.md](tools.md)). Declare them in a `TOOLS.json` at the skill root:

```json
{
  "version": 1,
  "tools": [
    {
      "name": "save_note",
      "description": "Persist a standup note. Write this for the model.",
      "category": "productivity",
      "risk": "low",
      "input_schema": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"]
      },
      "executor": "tools/save_note.ts",
      "execution_target": "sandbox"
    }
  ]
}
```

The executor is a module inside the skill directory exporting `run(input, context)` that returns `{ content: string, isError: boolean }`. It executes in the skill sandbox — a subprocess with a sanitized environment (`VELLUM_WORKSPACE_DIR` is available for locating plugin data) — so it must be self-contained: node stdlib only, no imports from outside the skill directory, no shared module state with hooks.

Rules the host enforces:

- **Sandbox only.** Plugin skills must declare `execution_target: "sandbox"`; `"host"` is refused for anything that is not a first-party bundled skill.
- **One owner per tool name.** Registering the same tool name from two different skills throws. When several sibling skills need one tool, put it in a single carrier skill and list that skill in each sibling's `metadata.vellum.includes` — loading any parent projects the child's tools automatically.
- **Dispatch via `skill_execute`.** The tools are not sent as top-level wire tools; `skill_load` renders their schemas into its output and the model calls them as `{"tool": "<name>", "input": {...}, "activity": "..."}` through `skill_execute`. Tools register when the skill activates and unregister when it deactivates, and execution is blocked if the skill directory changed since it was loaded (version-hash guard).

The `admin-copilot` marketplace plugin's `admin-copilot-prefs` skill is the reference implementation.
