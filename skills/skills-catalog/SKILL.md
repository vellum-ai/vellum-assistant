---
name: skills-catalog
description: Discover bundled skills and search/install community skills from the skills.sh registry
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🧩"
  vellum:
    display-name: "Skills Catalog"
---

You can help the user discover what skills are available and find community skills to extend the assistant's capabilities.

## Bundled skills (first-party)

First-party skills are **bundled** with the assistant - they are compiled in and always available. They do not need to be installed or downloaded. To activate a bundled skill, use the `skill_load` tool:

```
skill_load skill=<skill-id>
```

The skill catalog shown in the system prompt lists all bundled skills with their IDs. When a user asks about capabilities, refer to this list to find relevant bundled skills and load them as needed.

## Community skills (skills.sh)

Community skills are published on the skills.sh registry and can be searched, inspected, and installed on demand using the `assistant skills` CLI.

### Searching for community skills

```bash
assistant skills search "<query>"
```

Returns matching skills with their slug, source, install counts, and security audit badges. Use this when the user asks for a capability not covered by bundled skills.

### Installing a community skill

**Trust model - check the source owner before installing:**

- **Vellum-owned** (`vellum-ai/*`): First-party skills published by the Vellum team. Install these directly without prompting - they are vetted and trusted.
- **Third-party** (any other owner): Ask the user for permission first. Present the skill name, source, audit results, and install count. Say something like: "I found a community skill that could help, but it's published by a third party - we haven't vetted it. Want to install it anyway?"

```bash
assistant skills add <owner>/<repo>@<skill-name>
```

For example:
```bash
assistant skills add vercel-labs/skills@find-skills
```

Once installed, the skill appears in the workspace skills directory and can be loaded with `skill_load` like any other skill.

## Typical flow

1. **User asks about capabilities** - "Can you order food?" or "What can you do?"
   - Check the bundled skills list in the system prompt
   - Present relevant skills to the user
   - Load any that match with `skill_load`

2. **User wants a capability not covered by bundled skills** - "Can you do X?"
   - Search with `assistant skills search "<query>"`
   - Present matching results with descriptions, install counts, and audit badges
   - Check the source owner to determine trust level (see trust model above)
   - Install with `assistant skills add <owner>/<repo>@<skill-name>`
   - Load it with `skill_load`

3. **Skill has dependencies** - if `includes` lists other skill IDs, load those first with `skill_load`

## Notes

- Bundled skills are always available and do not need installation
- Community skills are installed to the workspace skills directory
- After installing a community skill, it is auto-enabled and immediately loadable
- Skills can be enabled or disabled via feature flags without uninstalling them
- Never install third-party community skills without explicit user confirmation
