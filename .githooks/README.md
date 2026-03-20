# Git Hooks

This directory contains shared git hooks for the vellum-assistant repository.

## Installation

Hooks are installed automatically when you run `bun install` in any package
(via a `postinstall` script that sets `core.hooksPath`).

To install manually:

```bash
git config core.hooksPath .githooks
```

This works in both regular checkouts and git worktrees.

## Available Hooks

### pre-commit

Automatically checks for plain text keys and secrets before allowing a commit.

**What it checks:**

1. **Secret scanning** — Detects plain text keys, tokens, passwords, and other sensitive information
2. **Prettier formatting** — Runs `prettier --check` on staged files in `assistant/`, `cli/`, and `gateway/`
3. **ESLint** — Runs `eslint` on staged source files in `assistant/`, `cli/`, and `gateway/`
4. **Message contract verification** — When message contract files are staged, verifies generated Swift models, inventory snapshot, and decoder sync are up to date
5. **Tool registration guard** — Blocks new tool registrations in `assistant/src/tools/` (requires Team Jarvis approval, see `assistant/src/tools/AGENTS.md`)

**Behavior:**
- Blocks commits containing potential secrets
- Blocks new tool files containing `implements Tool` or `registerTool()` patterns
- Provides detailed feedback on what was detected and where
- Allows clean commits to proceed without interruption
- Avoids known false positives for architecture/db identifier strings like `assistant_auth_tokens` and migration checkpoint keys
- Ignores checksum/hash fixture fields (for example `nonceSha256`) while still scanning adjacent lines
- Runs prettier and eslint on staged files in assistant, cli, and gateway directories
- **Merge-aware:** During merge commits, Prettier and ESLint only run on files the author changed on their branch — not files brought in from the other side of the merge. This prevents pre-existing formatting drift on main from blocking merge commits. Secret scanning still checks all staged files regardless.
- When message contract files are staged, verifies the generated Swift models and inventory snapshot are up to date
- Catches unstaged generated output files (e.g., regenerated but not `git add`-ed)

**Verification:**
- Run `.githooks/pre-commit --self-test` to verify safe architecture/db/checksum fixture strings are allowed while seeded real secrets are still detected.

**Bypass (not recommended):**
If you need to bypass this check in exceptional cases:
```bash
git commit --no-verify
```

### pre-push

Runs before pushing to catch issues that would fail CI.

**What it checks:**

1. **TypeScript type check** — Runs `tsc --noEmit` on `assistant/` when `.ts`/`.tsx` files changed. This backstops the pre-commit type check which is skipped in worktrees for performance.
2. **Lint** — Runs `eslint` on changed `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs` files in `assistant/`, `cli/`, and `gateway/`.
3. **Related tests** — Finds and runs test files matching changed source file stems using filename heuristics.

**Merge-aware:** When the push range contains merge commits, diffs against the `origin/main` merge-base instead of the remote branch tip, so after merging main into a feature branch only the feature branch's own changes are checked — not every file that came in from main.

**Bypass (not recommended):**
```bash
git push --no-verify
```
