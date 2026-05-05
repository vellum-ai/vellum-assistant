---
name: skill-management
description: Create and delete custom managed skills
metadata:
  emoji: "\U0001F9E9"
  vellum:
    display-name: "Skill Management"
    activation-hints:
      - "User wants to scaffold a new managed skill in their workspace from a description"
      - "User wants to delete or list the custom skills they have defined"
      - "User wants to author or edit a SKILL.md and have it become invocable as a skill"
    avoid-when:
      - "User just wants to use an existing skill — that is normal skill activation, not management"
---

Manage the lifecycle of custom managed skills in `{workspaceDir}/skills`.

## Capabilities

- **Scaffold** a new managed skill with YAML frontmatter and markdown body
- **Delete** an existing managed skill and remove it from the SKILLS.md index

Skills created via `scaffold_managed_skill` become available for `skill_load` immediately.
