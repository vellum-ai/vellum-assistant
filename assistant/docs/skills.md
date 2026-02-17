# Skills Support (`~/.vellum/workspace/skills`)

Vellum Assistant supports a skills catalog at:

- `~/.vellum/workspace/skills/SKILLS.md`

Each skill lives in its own directory:

- `~/.vellum/workspace/skills/<skill-id>/SKILL.md`

## `SKILLS.md` Format

`SKILLS.md` is a Markdown list of paths, one skill per list item, resolved relative to `~/.vellum/workspace/skills/`.

Supported entry forms:

- `- my-skill`
- `- my-skill/SKILL.md`
- `- [My Skill](my-skill)`

Notes:

- Absolute paths are ignored.
- Paths resolving outside `~/.vellum/workspace/skills/` are ignored.
- Duplicate entries are deduplicated (first entry wins).
- If `SKILLS.md` exists, it is authoritative for which skills are exposed.
- If `SKILLS.md` is missing, skills are auto-discovered from `~/.vellum/workspace/skills/*/SKILL.md`.

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

## `TOOLS.json` Manifest

A skill can declare custom tools by placing a `TOOLS.json` file in its directory alongside `SKILL.md`:

```
~/.vellum/workspace/skills/<skill-id>/TOOLS.json
```

### Format

```json
{
  "version": 1,
  "tools": [
    {
      "name": "run-lint",
      "description": "Run the project linter and return results.",
      "category": "code-quality",
      "risk": "low",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Directory to lint" }
        },
        "required": ["path"]
      },
      "executor": "tools/run-lint.ts",
      "execution_target": "host"
    }
  ]
}
```

### Fields

All fields on each tool entry are **required**.

| Field | Type | Description |
|---|---|---|
| `version` | `1` | Manifest schema version. Must be `1`. |
| `tools` | array | One or more tool entries. Must not be empty. |
| `tools[].name` | string | Unique tool name. Duplicate names within the same manifest are rejected. |
| `tools[].description` | string | Human-readable description shown to the model. |
| `tools[].category` | string | Grouping label for display purposes. |
| `tools[].risk` | `"low"` \| `"medium"` \| `"high"` | Default risk level for permission checks. `low` tools are auto-allowed, `medium` tools check trust rules before prompting, `high` tools always prompt. |
| `tools[].input_schema` | object | JSON Schema describing the tool's input parameters. |
| `tools[].executor` | string | Relative path to the executor script within the skill directory. |
| `tools[].execution_target` | `"host"` \| `"sandbox"` | Where the tool script runs. `host` runs directly on the user's machine; `sandbox` runs in an isolated environment. |

### Security Constraints

- **Relative paths only**: The `executor` field must be a relative path. Absolute paths (starting with `/`) are rejected.
- **No path traversal**: Executor paths must not contain `..` segments. The script must reside within the skill directory.
- **Skill-root confinement**: These constraints ensure a skill can only reference executors inside its own `~/.vellum/workspace/skills/<skill-id>/` subtree.

### Detection

When the skill catalog is built, each skill directory is checked for a `TOOLS.json` file. If present, its metadata (tool count, validity) is surfaced in the skill summary without loading the full manifest until the skill is activated.

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
