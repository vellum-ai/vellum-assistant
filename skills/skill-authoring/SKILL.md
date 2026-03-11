---
name: skill-authoring
description: Create, test, and manage custom skills when no existing tool or skill satisfies a request.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🛠️"
  vellum:
    display-name: "Skill Authoring"
---

## Dynamic Skill Authoring Workflow

When no existing tool or skill can satisfy a request, follow this workflow to create a new one.

### 1. Validate the gap

Confirm no existing tool or skill covers the request. Check `<available_skills>` and installed tools before proceeding.

### 2. Draft a snippet

Write a TypeScript snippet exporting a `default` or `run` function:

```typescript
export default function run(input: unknown): unknown | Promise<unknown> {
  // ...
}
```

### 3. Test the snippet

Write the snippet to a temp file with `bash` and run it with `bun`:

```bash
mkdir -p /tmp/vellum-eval && cat > /tmp/vellum-eval/snippet.ts << 'SNIPPET_EOF'
// ... your snippet ...
SNIPPET_EOF
bun run /tmp/vellum-eval/snippet.ts
```

Do not use `file_write` for temp files outside the working directory. Iterate until the snippet passes (max 3 attempts, then ask the user for guidance). Clean up temp files after testing.

### 4. Persist the skill

Only after explicit user consent, persist with `scaffold_managed_skill`. Provide:

- `skill_id` — kebab-case identifier
- `name` — human-readable name
- `description` — one-sentence summary
- `body_markdown` — the full SKILL.md body content

### 5. Load and use

Load the new skill with `skill_load` before use.

### Deleting skills

To remove a skill, use `delete_managed_skill`. **Never persist or delete skills without explicit user confirmation.**

### Session eviction

After a skill is written or deleted, the next turn may run in a recreated session due to file-watcher eviction. Continue normally.
