# Vellum Assistant — Agent Instructions

## Keep the README up to date

Whenever you modify, add, or remove a slash command in `.claude/commands/`, you MUST update `README.md` to reflect the change. The README's "Slash Commands" section should always match the current set of commands. Update the TLDR description if the command's purpose changed, add new entries for new commands, and remove entries for deleted commands.

## Keep the Architecture Diagram up to date

Whenever you introduce, remove, or significantly modify a service, module, or data flow, you MUST update `ARCHITECTURE.md` to reflect the change. The Mermaid diagrams should always accurately represent the current system architecture, including new services, IPC message types, storage locations, and data flows.

## Slash Commands — TLDR

These are the most commonly used slash commands defined in `.claude/commands/`:

| Command | What it does |
|---|---|
| `/work` | Pick one task from `.private/TODO.md` (or a user-provided task), implement it, open a PR, squash-merge it, and update tracking files. |
| `/do <description>` | Implement a described change in an isolated worktree, ship it to main via a squash-merged PR, and clean up. |
| `/swarm [workers] [max-tasks]` | Process `.private/TODO.md` in parallel — one worktree per agent, auto-merge PRs (auto-assigned to the current user), respawn agents until the list is empty. |
| `/blitz <feature>` | End-to-end feature delivery: plan, create GitHub issues on a project board, swarm-execute in parallel, sweep for review feedback, and report. |
| `/mainline [title]` | Ship the current uncommitted changes to main via a squash-merged PR. |
| `/brainstorm` | Read through the codebase and `.private/TODO.md`, generate a prioritized list of improvements, and update the TODO after user approval. |
| `/check-reviews` | Check every PR in `.private/UNREVIEWED_PRS.md` for Codex and Devin reviews; add feedback items to TODO and remove fully-reviewed PRs. |
| `/execute-plan <plan-file>` | Execute a multi-PR rollout plan from `.private/plans/` sequentially — implement, validate, and mainline each PR in order. |
| `/scrub` | Kill the running vellum-assistant app, wipe all persistent data, and relaunch the daemon and macOS app for a clean first-run experience. |
