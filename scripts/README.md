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

## PR check summary

Run `node scripts/pr-check-summary.mjs <pr-number-or-url>` from the repo root
when inspecting review state or CI on a pull request. It uses stable `gh pr view`
and `gh pr checks` JSON fields, then prints concise `PR`, `Checks`, `Review`,
and `Next steps` sections.

The helper exits 0 when inspection succeeds, even if checks are failing. It exits
non-zero only when it cannot inspect the PR. Pending or in-progress checks are
called out because logs may not be available yet. For fresh worktrees, run
`node scripts/agent-preflight.mjs` first to catch missing GitHub CLI auth or
helper setup.
