# Git Hooks

This directory contains shared git hooks for the vellum-assistant repository.

## Installation

To install the hooks, run:

```bash
./.githooks/install.sh
```

Or, you can configure git to use this directory directly:

```bash
git config core.hooksPath .githooks
```

## Available Hooks

### pre-commit

Automatically checks for plain text keys and secrets before allowing a commit.

**What it detects:**
- API keys and tokens
- AWS credentials (access keys, secret keys)
- Private keys (RSA, DSA, PEM)
- Passwords in plain text
- Database connection strings with credentials
- Bearer tokens
- Slack and GitHub tokens
- Generic secrets and high-entropy strings

**Behavior:**
- ✅ Blocks commits containing potential secrets
- ✅ Provides detailed feedback on what was detected and where
- ✅ Allows clean commits to proceed without interruption
- ✅ Avoids known false positives for architecture/db identifier strings like `assistant_auth_tokens` and migration checkpoint keys
- ✅ When IPC contract files are staged, verifies the generated Swift models and inventory snapshot are up to date
- ✅ Catches unstaged generated output files (e.g., regenerated but not `git add`-ed)

**Verification:**
- Run `.githooks/pre-commit --self-test` to verify safe architecture/db strings are allowed while seeded real secrets are still detected.

**Bypass (not recommended):**
If you need to bypass this check in exceptional cases:
```bash
git commit --no-verify
```

## Why Use Git Hooks?

Git hooks help maintain code quality and security by automatically running checks before certain git operations. The pre-commit hook specifically helps prevent accidentally committing sensitive information like API keys, passwords, and tokens to the repository.

## Maintenance

When updating hooks, make sure to:
1. Update the hook file in `.githooks/`
2. Run `./.githooks/install.sh` to update your local `.git/hooks/`
3. Commit and push the changes so other developers can update their hooks
