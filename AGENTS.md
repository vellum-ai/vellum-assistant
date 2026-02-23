# Vellum Assistant — Agent Instructions

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `assistant/` — Main backend service (Bun + TypeScript)
- `gateway/` — Telegram webhook gateway (Bun + TypeScript)
- `clients/macos/` — Native macOS desktop app (Swift/SwiftUI, see `clients/macos/CLAUDE.md`)
- `scripts/` — Utility scripts
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`)

## Conventions

- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Package manager**: Use `bun install` for dependencies, `bun test` for tests, `bunx tsc --noEmit` for type-checking.
- **Install dependencies**: `cd assistant && bun install` (each package has its own `bun.lock`).

## Development

```bash
# Install dependencies
cd assistant && bun install

# Type-check
cd assistant && bunx tsc --noEmit

# Run tests
cd assistant && bun test

# Lint
cd assistant && bun run lint
```

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
| `/do <description>` | Implement a described change in an isolated worktree, ship it to main via a squash-merged PR, and clean up. The PR body includes the original prompt for traceability. |
| `/safe-do <description>` | Like `/do` but creates a PR without auto-merging — pauses for human review. Keeps the worktree in place for addressing feedback. The PR body includes the original prompt for traceability. |
| `/swarm [workers] [max-tasks] [--namespace NAME]` | Process `.private/TODO.md` in parallel — one worktree per agent, auto-merge PRs (auto-assigned to the current user), respawn agents until the list is empty. Uses `--namespace` to prefix branch names and avoid collisions with other parallel swarms (auto-generates a random 4-char hex if omitted). When `--namespace` is explicitly provided, only TODO items prefixed with `[<namespace>]` are processed; when auto-generated, all items are processed. |
| `/blitz <feature>` | End-to-end feature delivery: plan, create GitHub issues on a project board, swarm-execute in parallel, then run a recursive sweep loop (check reviews, swarm to address feedback, repeat) until all PRs — including transitive feedback PRs — are fully reviewed. Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. |
| `/safe-blitz <feature>` | Like `/blitz` but merges milestone PRs into a feature branch instead of main, with per-milestone recursive sweep loops and a final sweep before opening a PR for manual review. Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. Supports `--auto`, `--workers N`, `--skip-plan`, `--branch NAME`. |
| `/safe-blitz-done [PR\|branch]` | Finalize a safe-blitz — squash-merge the feature branch PR into main, set the project issue to Done, close the issue, and clean up locally. Auto-detects from current branch, open `feature/*` PRs, or project board. |
| `/mainline [title]` | Ship the current uncommitted changes to main via a squash-merged PR. The PR body includes the original prompt (if provided) for traceability. |
| `/ship-and-merge [title]` | Create a PR, wait for Codex and Devin reviews, fix valid feedback (up to 3 rounds), and squash-merge once approved. The PR body includes the original prompt (if provided) for traceability. |
| `/brainstorm` | Read through the codebase and `.private/TODO.md`, generate a prioritized list of improvements, and update the TODO after user approval. |
| `/check-reviews [--namespace NAME] [--branch NAME]` | Check every PR in `.private/UNREVIEWED_PRS.md` for Codex and Devin reviews; add feedback items to TODO and remove fully-reviewed PRs. When `--namespace` is provided, only PRs whose head branch starts with `swarm/<namespace>/` are processed, and TODO items are prefixed with `[<namespace>]`. When omitted, all PRs are processed, but TODO items are still namespaced if the PR's branch matches `swarm/<NAME>/...` (inferred from the branch name). Use `--branch` to control which branch CI failures are checked on (default: `main`), useful when PRs merge into a feature branch instead of main. |
| `/execute-plan <plan-file>` | Execute a multi-PR rollout plan from `.private/plans/` sequentially — implement, validate, and mainline each PR in order. The PR body includes the full plan content for traceability. |
| `/safe-execute-plan <file>` | Start a plan from `.private/plans/` — implements the first PR, creates it (without merging), and stops to wait for human review. The PR body includes the full plan content for traceability. |
| `/safe-check-review [file]` | Check the active plan PR for review feedback from codex/devin/humans. Addresses requested changes, waits if reviews are pending. |
| `/resume-plan [file]` | Merge the current plan PR, implement the next one, create it, and stop again. Repeats until the plan is complete. The PR body includes the full plan content for traceability. |

| `/update` | Pull latest from main, restart the backend daemon, and rebuild/launch the macOS app. |


## Track merged PRs

Whenever you merge a PR, you MUST append its URL to `.private/UNREVIEWED_PRS.md` so that `/check-reviews` can pick it up for review triage.

## Implementing new functionality
Before implementing new functionality do a quick check to see if the new feature has already been implemented

## Extensibility Principle

Vellum is a **general-purpose assistant**, not a single-purpose tool. When adding a new capability (e.g., personalized email responses, context-aware summarization, smart scheduling), build it as a **reusable, extensible primitive** that works across contexts — not a narrow solution wired to one specific use case.

Concretely:
- Extract the underlying capability (e.g., "personalize text using user context") into a composable building block (skill, tool, or utility) that other features can reuse.
- Parameterize inputs and outputs rather than hardcoding them to a single workflow.
- If a capability already exists in a general form, extend it rather than building a parallel special-purpose version.
- Ask: "If someone wanted this same capability in a different context, would they be able to use what I'm building?" If not, generalize it.

## Code Review Checklist

When reviewing PRs (applies to all reviewers — Codex, Devin, and humans), flag these in addition to standard code quality:

- **Special-purpose capability added:** When a PR introduces a capability that is specific to one use case (e.g., a dedicated Google Cloud OAuth flow for Gmail), flag it for human review — don't reject it. Sometimes special-purpose implementations are the right call (e.g., making a painful setup "magical" requires specificity). The reviewer's job is to surface it so a human can decide whether it should be generalized or is fine as-is.
- **Duplicate capability:** The PR adds functionality that already exists in a general form elsewhere in the codebase. Suggest reusing the existing implementation.
- **Missing parameterization:** Inputs, outputs, or behaviors are hardcoded when they should be configurable or context-driven.

## Human Attention Comments on PRs

After creating a PR, consider whether it contains anything that genuinely warrants focused human review. If it does, leave a single comment highlighting where attention is most needed. This helps humans quickly triage PRs.

**This is not mandatory.** Skip the comment entirely for routine, low-risk PRs that follow existing patterns — don't add noise. Only comment when you believe a human should look closely at specific parts of the diff.

**When to comment:**
- Architectural decisions or new patterns that set precedent
- Security-sensitive changes (auth, permissions, secrets, input validation)
- Complex business logic with subtle edge cases
- Changes that touch critical paths (data pipelines, payment flows, etc.)
- Deletions or removals of existing functionality
- Areas where you are least confident in the implementation

**When to skip:** Routine changes — renaming, formatting, boilerplate, straightforward additions that follow existing patterns exactly, or changes you are fully confident in.

**How:** `gh pr comment <number> --body "<comment>"`

**Comment format:**

```
## 👀 Where to focus your review

- **<file_path or area>**: <why this needs attention — e.g., "New architectural pattern that sets precedent", "Security-sensitive change to auth flow", "Complex logic with subtle edge cases">
- ...

**Risk level:** <Medium | High> — <one-sentence explanation of overall risk>
```

## Tooling Direction

Do not add new tool registrations using the `class ____Tool implements Tool {` pattern.

Prefer skills in `assistant/skills/vellum-skills/` that teach the model how to use CLI tools directly.

Keep the system prompt as minimal as possible. Avoid adding instructions about how to use tools; only document what tools exist when they are basic, primitive, and universally useful. Prefer CLI programs that the assistant can progressively learn to use via `--help`.

## Migration Guidance

When touching existing tool-based flows, migrate behavior toward skill-driven CLI usage instead of adding new registered tools.

Reasoning: every registered tool increases model context overhead, while the model can usually learn CLI usage from skills on demand and install missing CLI dependencies when needed.
