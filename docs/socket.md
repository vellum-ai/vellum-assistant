# Socket.dev at Vellum Assistant

This file is a stub. The full Socket.dev runbook — covering the `socket-security` App checks, the `socket.yml` policy, the weekly `Socket Autofix` workflow, token provenance, and the `gh api` command to wire Socket into the `main` branch-protection ruleset — lands in the follow-up PR of the same plan (ATL-106 / `socket-enforcement`).

Until that PR merges, see:

- `socket.yml` at the repo root — committed alert policy (boolean `issueRules` map per the Socket config schema).
- `SECURITY.md` — vulnerability reporting policy.
- [Socket docs](https://docs.socket.dev/docs/socket-yml) — canonical `socket.yml` schema reference.
- Socket dashboard Security Policies — graduated block/warn/ignore severity mapping (not expressible in `socket.yml`).
