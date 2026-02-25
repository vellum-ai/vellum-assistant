---
name: "Skills Catalog"
description: "Browse and install skills from the Vellum catalog using the vellum skills CLI"
user-invocable: true
metadata: {"vellum": {"emoji": "🧩"}}
---

You can help the user discover and install skills from the Vellum first-party catalog using the `vellum skills` CLI.

## Listing available skills

```bash
vellum skills list --json
```

Returns a JSON object with `ok: true` and a `skills` array. Each skill has:
- `id` — the skill identifier (used for install)
- `name` — human-readable name
- `description` — what the skill does
- `emoji` — optional emoji
- `includes` — optional list of dependency skill IDs
- `version` — optional version string

## Installing a skill

```bash
vellum skills install <skill-id> --json
```

Installs the skill to the managed skills directory. If the skill is already installed, it will be overwritten by default. Pass `--overwrite` to be explicit.

Returns `{ "ok": true, "skillId": "<id>" }` on success.

## Typical flow

1. **User asks about capabilities** — "Can you order food?" or "What can you do?"
   - Run `vellum skills list --json` to see what's available
   - Present relevant skills to the user

2. **User wants a new skill** — "I want to use Slack" or "Set up Telegram"
   - Run `vellum skills list --json` to find matching skills
   - Run `vellum skills install <skill-id> --json` to install it
   - The skill will be available on the next conversation turn

3. **Skill has dependencies** — if `includes` lists other skill IDs, install those first

## Notes

- Skills are fetched from the Vellum platform API with a bundled fallback
- Installed skills are stored in `~/.vellum/assistant/skills/<skill-id>/`
- After installing, the skill may need to be enabled in settings
- Use `--json` on all commands for reliable parsing
