# OpenClaw → Vellum config key mapping

The inventory script reads this file on every run. Add rows here when a new mapping is discovered. Use a backticked source key in the first column. Empty or `—` in the second column means "no known mapping; ask the user".

| source                           | destination               | notes                                                                                                                                   |
| -------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.defaults.model.primary`  | `defaults.model.primary`  | Format `<provider>/<model>` (e.g. `anthropic/claude-opus-4-6`).                                                                         |
| `agents.defaults.model.fallback` | `defaults.model.fallback` | Same format. May not exist on every install.                                                                                            |
| `gateway.auth.token`             | —                         | OpenClaw and Vellum gateways use different signing schemes; do **not** copy the raw token. Issue a fresh Vellum webhook secret instead. |
| `env.OPENCLAW_NPM_LOGLEVEL`      | —                         | OpenClaw-specific. Drop.                                                                                                                |
| `env.OPENCLAW_NO_ONBOARD`        | —                         | OpenClaw-specific. Drop.                                                                                                                |
| `env.OPENCLAW_NO_PROMPT`         | —                         | OpenClaw-specific. Drop.                                                                                                                |

## Adding a new mapping

1. Find the OpenClaw key (`openclaw config get <key>` or in `~/.openclaw/config.*`).
2. Find the Vellum equivalent (look in `assistant config --help` or the workspace config schema).
3. Add a row above with both keys backticked.
4. Note any value-format differences (e.g. `<provider>/<model>` strings, JSON vs YAML).

If a key has no Vellum equivalent — for example, OpenClaw-only env vars — leave the destination empty (`—`) and explain why in notes.
