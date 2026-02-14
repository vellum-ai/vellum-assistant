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

## Slash Skill Commands

Users can invoke skills directly from any chat surface using slash commands:

```
/skill-id [optional arguments]
```

### Behavior

- **Matching**: Exact skill ID only (case-insensitive). No fuzzy matching, prefix matching, or name aliasing.
- **Parse**: Happens on send — the first whitespace-delimited token is inspected. If it starts with `/` and is a valid skill ID, it's treated as a slash command.
- **Known command**: Content is rewritten into a model-facing prompt that instructs the assistant to invoke the skill. Trailing arguments are preserved verbatim.
- **Unknown command**: A deterministic assistant response is returned listing available slash commands. No model call occurs.
- **Path-like tokens**: Tokens with multiple slashes (e.g. `/tmp/file`, `/Users/sidd`) are ignored and treated as normal text.
- **Task submit**: Slash candidates in `task_submit` bypass the interaction classifier and route directly to `text_qa`, preventing misrouting to `computer_use`.

### Eligibility

A skill appears as a slash command when:

1. `userInvocable` is `true` in its configuration.
2. Its resolved state is not `disabled`.

### Valid Skill IDs

Slash skill IDs must start with an alphanumeric character and contain only `[A-Za-z0-9._-]`.
