---
name: "Skills Catalog"
description: "Discover bundled skills and search/install community skills from Clawhub"
user-invocable: true
metadata: { "vellum": { "emoji": "🧩" } }
---

You can help the user discover what skills are available and find community skills to extend the assistant's capabilities.

## Bundled skills (first-party)

First-party skills are **bundled** with the assistant — they are compiled in and always available. They do not need to be installed or downloaded. To activate a bundled skill, use the `skill_load` tool:

```
skill_load skill=<skill-id>
```

The skill catalog shown in the system prompt lists all bundled skills with their IDs. When a user asks about capabilities, refer to this list to find relevant bundled skills and load them as needed.

## Community skills (Clawhub)

Community skills are published on [Clawhub](https://clawhub.com) and can be searched and installed on demand.

### Searching for community skills

Use the `skill_load` tool to search the catalog, or check the system prompt's available skills list. The IPC `skills_search` message searches both bundled and community skills.

### Installing a community skill

Community skills are installed via the IPC `skills_install` message with a `slug` parameter. Once installed, they appear in `~/.vellum/workspace/skills/<slug>/` and can be loaded with `skill_load` like any other skill.

### Inspecting a community skill

Before installing, you can inspect a community skill via the IPC `skills_inspect` message with a `slug` parameter. This returns metadata (author, stats, version) and optionally the skill's SKILL.md content so the user can review it.

## Typical flow

1. **User asks about capabilities** — "Can you order food?" or "What can you do?"
   - Check the bundled skills list in the system prompt
   - Present relevant skills to the user
   - Load any that match with `skill_load`

2. **User wants a capability not covered by bundled skills** — "Can you do X?"
   - Search for community skills that provide the capability
   - Present matching results with descriptions and install counts
   - Install the chosen skill, then load it with `skill_load`

3. **Skill has dependencies** — if `includes` lists other skill IDs, load those first with `skill_load`

## Notes

- Bundled skills are always available and do not need installation
- Community skills are installed to `~/.vellum/workspace/skills/<slug>/`
- After installing a community skill, it may need to be enabled in settings
- Skills can be enabled or disabled via feature flags without uninstalling them
