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
- Skill tools are **not** available globally — they are only registered when their owning skill is active.

### Tool Activation

A skill's tools become available through one of two mechanisms:

1. **`skill_load` tool** — When the assistant calls `skill_load` for a skill, the tool result includes a `<loaded_skill id="..." />` marker. On the next agent turn, the session scans conversation history for these markers, loads each active skill's `TOOLS.json`, and registers the declared tools.

2. **Slash preactivation** — When a user invokes a known slash command (e.g. `/gmail`), the session sets the skill's ID as preactivated before the agent loop begins. This makes the skill's tools available on the first turn without requiring the assistant to call `skill_load` first. Preactivation is cleared at the end of the agent loop run.

Both mechanisms are unioned: a skill is active if it has a `<loaded_skill>` marker in the visible history **or** was preactivated via slash resolution.

### Context-Derived Deactivation

Active skill state is recomputed on every agent turn by scanning the current conversation history for `<loaded_skill id="..." />` markers. If a skill's marker is no longer present — for example, because the message containing it was truncated from the context window — the skill is considered inactive. Its tools are unregistered from the tool registry and removed from the allowed set for subsequent turns.

This means skill activation is **ephemeral and context-dependent**: a skill stays active only as long as its marker is visible in the conversation. There is no persistent activation state outside of the conversation history (aside from per-turn preactivation via slash commands).

### Permission Defaults

Skill-origin tools are treated differently from built-in tools for permission checks:

- **Without a matching trust rule**: Skill tools **always prompt** the user for approval, regardless of the tool's declared risk level. Even a `low`-risk skill tool will prompt if no trust rule matches. This prevents third-party skill tools from silently auto-executing.
- **With a matching trust rule**: Trust rules (`allow`, `deny`, `ask`) override the default and behave normally — `allow` auto-allows (except for `high` risk), `deny` auto-denies, and `ask` always prompts.

This default-prompt behavior is specific to tools with `origin: 'skill'`. Built-in tools follow the standard risk-based fallback (low = auto-allow, medium = prompt, high = always prompt).

### Execution Backends

Each skill tool declares an `execution_target` in its manifest:

| Target | Behavior |
|---|---|
| `host` | Runs **in-process** via dynamic `import()`. The executor script's `run()` function is called directly in the daemon process with full access to the host environment. |
| `sandbox` | Runs in an **isolated subprocess** with a configurable timeout. The executor script is spawned separately, limiting its access to the host process. |

### Bundled Skills

The following skills are shipped with the assistant and live under `assistant/src/config/bundled-skills/`:

| Skill | Tools | Notes |
|---|---|---|
| **Gmail** | 12 tools | `gmail_search`, `gmail_list_messages`, `gmail_get_message`, `gmail_mark_read`, `gmail_draft`, `gmail_archive`, `gmail_batch_archive`, `gmail_label`, `gmail_batch_label`, `gmail_trash`, `gmail_send`, `gmail_unsubscribe` |
| **Claude Code** | 1 tool | `claude_code` — delegates coding tasks to Claude Code as a subprocess |
| **Weather** | 1 tool | `get_weather` — retrieves current conditions and forecasts |

Bundled skills follow the same activation rules as user-installed skills. Their tools are only available when the skill is active (via `skill_load` or slash preactivation).

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
