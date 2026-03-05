---
name: "Skills Catalog"
description: "Discover bundled skills and search/install skills from the Vellum catalog and Clawhub"
user-invocable: true
metadata: { "vellum": { "emoji": "🧩" } }
---

You can help the user discover what skills are available and find new skills to extend the assistant's capabilities.

## Bundled skills (first-party)

First-party skills are **bundled** with the assistant — they are compiled in and always available. They do not need to be installed or downloaded. To activate a bundled skill, use the `skill_load` tool:

```
skill_load skill=<skill-id>
```

The skill catalog shown in the system prompt lists all bundled skills with their IDs. When a user asks about capabilities, refer to this list to find relevant bundled skills and load them as needed.

## Vellum catalog skills

Additional first-party skills are published in the Vellum catalog and can be discovered and installed using the `vellum` CLI.

### Listing available skills

```bash
vellum skills list
```

Returns all skills available in the Vellum catalog with their IDs, names, and descriptions.

### Installing a skill

```bash
vellum skills install <skill-id>
```

Downloads and installs the skill to `~/.vellum/workspace/skills/<skill-id>/`. If the skill includes a `package.json`, dependencies are installed automatically. Once installed, load it with `skill_load` like any other skill.

Use `--overwrite` to replace an already-installed skill (e.g. to update it).

## Community skills (Clawhub)

Community skills are published on Clawhub and can be searched, inspected, and installed on demand using the `clawhub` CLI via bash.

### Searching for community skills

```bash
npx clawhub search "<query>" --limit 10
```

Returns matching skills with their slug, version, and name. Use this when the user asks for a capability not covered by bundled or Vellum catalog skills.

To browse trending/popular skills without a specific query:

```bash
npx clawhub explore --json --limit 10
```

### Inspecting a community skill

Before installing, inspect a skill to review its metadata, author, stats, and SKILL.md content:

```bash
npx clawhub inspect <slug> --json --files --file SKILL.md
```

Present the results to the user so they can decide whether to install.

### Installing a community skill

```bash
npx clawhub install <slug> --force --workdir ~/.vellum/workspace
```

Once installed, the skill appears in `~/.vellum/workspace/skills/<slug>/` and can be loaded with `skill_load` like any other skill.

## Typical flow

1. **User asks about capabilities** — "Can you order food?" or "What can you do?"
   - Check the bundled skills list in the system prompt
   - Present relevant skills to the user
   - Load any that match with `skill_load`

2. **User wants a capability not covered by bundled skills** — "Can you do X?"
   - List available Vellum catalog skills with `vellum skills list`
   - If a match is found, install it with `vellum skills install <skill-id>`
   - If not found in the Vellum catalog, search community skills with `npx clawhub search "<query>"`
   - Optionally inspect promising results with `npx clawhub inspect <slug> --json`
   - Install the chosen skill with `npx clawhub install <slug> --force --workdir ~/.vellum/workspace`
   - Load it with `skill_load`

3. **Skill has dependencies** — if `includes` lists other skill IDs, load those first with `skill_load`

## Notes

- Bundled skills are always available and do not need installation
- Vellum catalog and community skills are installed to `~/.vellum/workspace/skills/<id>/`
- After installing a skill, it is auto-enabled and immediately loadable
- Skills can be enabled or disabled via feature flags without uninstalling them
- Run `npx clawhub --help` to discover additional Clawhub CLI options
