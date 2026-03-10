---
name: skills-catalog
description: Discover bundled skills and search/install community skills from Clawhub
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🧩"
  vellum:
    display-name: "Skills Catalog"
    user-invocable: true
---

You can help the user discover what skills are available and find community skills to extend the assistant's capabilities.

## Bundled skills (first-party)

First-party skills are **bundled** with the assistant — they are compiled in and always available. They do not need to be installed or downloaded. To activate a bundled skill, use the `skill_load` tool:

```
skill_load skill=<skill-id>
```

The skill catalog shown in the system prompt lists all bundled skills with their IDs. When a user asks about capabilities, refer to this list to find relevant bundled skills and load them as needed.

## Community skills (Clawhub)

Community skills are published on Clawhub and can be searched, inspected, and installed on demand using the `clawhub` CLI via bash.

### Searching for community skills

```bash
npx clawhub search "<query>" --limit 10
```

Returns matching skills with their slug, version, and name. Use this when the user asks for a capability not covered by bundled skills.

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
   - Search with `npx clawhub search "<query>"`
   - Optionally inspect promising results with `npx clawhub inspect <slug> --json`
   - Present matching results with descriptions and install counts
   - Install the chosen skill with `npx clawhub install <slug> --force --workdir ~/.vellum/workspace`
   - Load it with `skill_load`

3. **Skill has dependencies** — if `includes` lists other skill IDs, load those first with `skill_load`

## Notes

- Bundled skills are always available and do not need installation
- Community skills are installed to `~/.vellum/workspace/skills/<slug>/`
- After installing a community skill, it is auto-enabled and immediately loadable
- Skills can be enabled or disabled via feature flags without uninstalling them
- Run `npx clawhub --help` to discover additional CLI options
