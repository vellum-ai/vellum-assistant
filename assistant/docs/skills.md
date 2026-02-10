# Skills Support (`~/.vellum/skills`)

Vellum Assistant supports a skills catalog at:

- `~/.vellum/skills/SKILLS.md`

Each skill lives in its own directory:

- `~/.vellum/skills/<skill-id>/SKILL.md`

## `SKILLS.md` Format

`SKILLS.md` is a Markdown list of paths, one skill per list item, resolved relative to `~/.vellum/skills/`.

Supported entry forms:

- `- my-skill`
- `- my-skill/SKILL.md`
- `- [My Skill](my-skill)`

Notes:

- Absolute paths are ignored.
- Paths resolving outside `~/.vellum/skills/` are ignored.
- Duplicate entries are deduplicated (first entry wins).
- If `SKILLS.md` exists, it is authoritative for which skills are exposed.
- If `SKILLS.md` is missing, skills are auto-discovered from `~/.vellum/skills/*/SKILL.md`.

## `SKILL.md` Requirements

Each `SKILL.md` must include YAML frontmatter with:

- `name`
- `description`

Example:

```md
---
name: "Release Checklist"
description: "Run pre-release validation and deployment checks."
---

1. Run tests
2. Build artifacts
3. Verify release notes
```

Skills missing valid frontmatter are skipped.

## Runtime Behavior

- System prompt appends a **Skills Catalog** with skill id, name, and description.
- The assistant can lazily load full skill instructions with the `skill_load` tool.

## `skill_load` Tool

Tool schema:

```json
{
  "skill": "string"
}
```

Resolution order:

1. Exact skill id
2. Exact skill name (case-insensitive)
3. Unique skill id prefix

If the selector is ambiguous or missing, `skill_load` returns an error.
