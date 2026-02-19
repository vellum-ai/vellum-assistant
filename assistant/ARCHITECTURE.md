# Architecture

## Slash Command Routing

### Dual-source slash routing

Slash commands (`/command-name`) can originate from two sources:

1. **Vellum skills** — Installed in `~/.vellum/workspace/skills/`, loaded via `skill_load`.
2. **CC commands** — Markdown files in `.claude/commands/*.md`, discovered by walking up from the working directory.

When a user types `/something`, the router checks both sources and dispatches accordingly.

### Scoped CC command registry

CC command discovery walks up the directory tree from `cwd`, scanning for `.claude/commands/` directories at each level. The nearest directory wins on name collisions (child overrides parent). Results are cached per cwd with a 30-second TTL.

### Collision preference

When a slash command name exists in both Vellum skills and CC commands, the `slashCollisionPreference` config option controls resolution:

- `ask` (default) — Prompt the user to choose which source to use.
- `prefer_vellum` — Silently pick the Vellum skill.
- `prefer_cc` — Silently pick the CC command.

### How to add CC commands

1. Create a `.claude/commands/` directory in your project (or any ancestor directory).
2. Add a `.md` file with the command name as the filename (e.g., `review.md`).
3. The first non-empty line (after optional YAML frontmatter) becomes the command summary shown in the system prompt.
4. The full markdown content is used as the command template at execution time.

Valid command names match `[A-Za-z0-9][A-Za-z0-9._-]*`.
