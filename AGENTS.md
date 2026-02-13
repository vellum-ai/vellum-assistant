# Vellum Assistant — Agent Instructions

## Keep the README up to date

Whenever you modify, add, or remove a slash command in `.claude/commands/`, you MUST update `README.md` to reflect the change. The README's "Slash Commands" section should always match the current set of commands. Update the TLDR description if the command's purpose changed, add new entries for new commands, and remove entries for deleted commands.

## Comments

Comments should explain **why** something is done and provide non-obvious context, not describe what the code does. If the code is clear enough to understand on its own, it doesn't need a comment. Reserve comments for surprising behavior, subtle invariants, workarounds, and design rationale.

## Keep the Architecture Diagram up to date

Whenever you introduce, remove, or significantly modify a service, module, or data flow, you MUST update `ARCHITECTURE.md` to reflect the change. The Mermaid diagrams should always accurately represent the current system architecture, including new services, IPC message types, storage locations, and data flows.

## Slash Commands — TLDR

These are the most commonly used slash commands defined in `.claude/commands/`:

| Command | What it does |
|---|---|
| `/work` | Pick one task from `.private/TODO.md` (or a user-provided task), implement it, open a PR, squash-merge it, and update tracking files. |
| `/do <description>` | Implement a described change in an isolated worktree, ship it to main via a squash-merged PR, and clean up. |
| `/safe-do <description>` | Like `/do` but creates a PR without auto-merging — pauses for human review. Keeps the worktree in place for addressing feedback. |
| `/swarm [workers] [max-tasks]` | Process `.private/TODO.md` in parallel — one worktree per agent, auto-merge PRs (auto-assigned to the current user), respawn agents until the list is empty. |
| `/blitz <feature>` | End-to-end feature delivery: plan, create GitHub issues on a project board, swarm-execute in parallel, sweep for review feedback, and report. |
| `/safe-blitz <feature>` | Like `/blitz` but merges milestone PRs into a feature branch instead of main, then opens a final PR for manual review. Supports `--auto`, `--workers N`, `--skip-plan`, `--branch NAME`. |
| `/safe-blitz-done [PR\|branch]` | Finalize a safe-blitz — squash-merge the feature branch PR into main, set the project issue to Done, close the issue, and clean up locally. Auto-detects from current branch, open `feature/*` PRs, or project board. |
| `/mainline [title]` | Ship the current uncommitted changes to main via a squash-merged PR. |
| `/brainstorm` | Read through the codebase and `.private/TODO.md`, generate a prioritized list of improvements, and update the TODO after user approval. |
| `/check-reviews` | Check every PR in `.private/UNREVIEWED_PRS.md` for Codex and Devin reviews; add feedback items to TODO and remove fully-reviewed PRs. |
| `/execute-plan <plan-file>` | Execute a multi-PR rollout plan from `.private/plans/` sequentially — implement, validate, and mainline each PR in order. |
| `/safe-execute-plan <file>` | Start a plan from `.private/plans/` — implements the first PR, creates it (without merging), and stops to wait for human review. |
| `/safe-check-review [file]` | Check the active plan PR for review feedback from codex/devin/humans. Addresses requested changes, waits if reviews are pending. |
| `/resume-plan [file]` | Merge the current plan PR, implement the next one, create it, and stop again. Repeats until the plan is complete. |
| `/scrub` | Kill the running Vellum app (non-fatal if not running), wipe all persistent data, and relaunch the daemon and macOS app for a clean first-run experience. |
