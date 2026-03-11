---
name: skill-management
description: Create and delete custom managed skills
metadata:
  vellum:
    emoji: "\U0001F9E9"
    display-name: "Skill Management"
    user-invocable: true
---

Manage the lifecycle of custom managed skills in `~/.vellum/workspace/skills`.

## Capabilities

- **Scaffold** a new managed skill with YAML frontmatter and markdown body
- **Delete** an existing managed skill and remove it from the SKILLS.md index

Skills created via `scaffold_managed_skill` become available for `skill_load` immediately.
