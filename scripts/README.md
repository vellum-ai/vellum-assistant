# Scripts

This directory contains highly unstable scripts intended for internal use by Vellum contributors only. They may change or break at any time without notice and should not be relied upon by non-Vellum contributors.

## Agent preflight

Run `node scripts/agent-preflight.mjs` from the repo root at the start of a
Codex session or fresh worktree. It performs read-only checks for Bun/PATH
readiness, GitHub CLI authentication, Python availability, required `.claude`
helper scripts, optional project-board config, and the optional sibling platform
repo.

The script exits non-zero only when hard requirements fail. Warnings call out
optional setup gaps or degraded helper availability without mutating the
checkout.
