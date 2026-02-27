---
name: "Skills Catalog"
description: "Browse, search, and install skills from the Vellum first-party catalog and skills.sh third-party marketplace"
user-invocable: true
metadata: {"vellum": {"emoji": "🧩"}}
---

You can help the user discover and install skills from the Vellum first-party catalog and the skills.sh third-party marketplace using the `vellum skills` CLI.

## First-party skills (Vellum catalog)

### Listing available skills

```
host_bash: vellum skills list --json
```

Returns a JSON object with `ok: true` and a `skills` array. Each skill has:
- `id` — the skill identifier (used for install)
- `name` — human-readable name
- `description` — what the skill does
- `emoji` — optional emoji
- `includes` — optional list of dependency skill IDs
- `version` — optional version string

### Installing a first-party skill

```
host_bash: vellum skills install <skill-id> --json
```

Installs the skill to the managed skills directory. If the skill is already installed, pass `--overwrite` to replace it.

Returns `{ "ok": true, "skillId": "<id>" }` on success.

## Third-party skills (skills.sh)

### Searching for skills

```
host_bash: vellum skills search "<query>" --limit 5 --json
```

Returns a list of matching skills with their risk levels and audit details from skills.sh.

### Evaluating a skill's security

```
host_bash: vellum skills evaluate <source> <skillId> --json
```

Fetches the security audit and produces a recommendation. The `source` is the GitHub repo path (e.g. `inference-sh-9/skills`) and `skillId` is the skill name (e.g. `youtube-thumbnail-design`).

The security recommendation will be one of:
- **proceed** — Safe/low risk. All audits passed. You may proceed with installation after confirming with the user.
- **proceed_with_caution** — Medium risk detected. Present the rationale to the user and get explicit confirmation before installing.
- **do_not_recommend** — High, critical, or unknown risk. Warn the user strongly. Explain the specific risks identified in the rationale. Only install if the user explicitly overrides after understanding the risks.

### Installing a third-party skill

```
host_bash: vellum skills install <source> <skillId> --json
```

Runs the full install flow with security check. Pass `--override` to install despite a `do_not_recommend` security assessment:

```
host_bash: vellum skills install <source> <skillId> --override --json
```

## Typical flow

1. **User asks about capabilities** — "Can you order food?" or "What can you do?"
   - Run `vellum skills list --json` to see what first-party skills are available
   - Present relevant skills to the user

2. **User wants a new first-party skill** — "I want to use Slack" or "Set up Telegram"
   - Run `vellum skills list --json` to find matching skills
   - Run `vellum skills install <skill-id> --json` to install it
   - The skill will be available on the next conversation turn

3. **Skill has dependencies** — if `includes` lists other skill IDs, install those first

4. **User needs something not in the first-party catalog** — or a native capability fails
   - Run `vellum skills search "<query>" --json` to search skills.sh
   - Run `vellum skills evaluate <source> <skillId> --json` for security audit
   - Present the security recommendation and rationale to the user
   - If approved, run `vellum skills install <source> <skillId> --json`
   - For `do_not_recommend` skills that the user explicitly overrides: `vellum skills install <source> <skillId> --override --json`

5. **After installing any skill**, load it so it becomes available in the current session:
   ```
   skill_load skill=<skillId>
   ```
   Then retry the original task using the newly loaded skill's capabilities.

## Loop guards

- Attempt the third-party fallback flow at most **once per user request**. If the installed skill also fails, report the failure to the user rather than searching for another skill.
- Do not re-search for skills that were already evaluated and rejected (by the user or by security policy) in the same session.

## Notes

- First-party skills are fetched from the Vellum platform API
- Third-party skills are fetched from skills.sh with security audit
- Installed skills are stored in `~/.vellum/workspace/skills/<skill-id>/`
- After installing, the skill may need to be enabled in settings
- Use `--json` on all commands for reliable parsing
