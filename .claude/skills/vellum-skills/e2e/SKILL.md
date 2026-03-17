---
name: e2e
description: >
  Run end-to-end tests via the CI workflow.
---

Run end-to-end tests via the CI workflow.

The user may pass `$ARGUMENTS` to filter to a specific test case by name (e.g., `hello-world`, `phone-setup`). If not provided, infer options from context (see below).

## Steps

### 1. Determine options

**Experimental tests:** Always include `--experimental` by default. The user can pass `--no-experimental` to exclude them.

**Branch detection:** Check what branch you're on via `git branch --show-current`. If you're on a branch other than `main`, automatically pass `-b <branch-name>` so the CI run tests against that branch. The user can override with `-b <other-branch>` explicitly.

**Test case filter:** Determine which test case to target:
1. If the user passes a bare word argument (e.g., `phone-setup`), use that as the filter.
2. Otherwise, look at the conversational context - if you've been working on or discussing a specific e2e test case (e.g., editing `playwright/cases/phone-setup.md`), automatically target that test case.
3. If neither applies, run all tests.

**Additional flags from `$ARGUMENTS`:**
- `--xcode` uses the agent-xcode (AXUIElement) runner
- `-d` or `--detach` triggers the run and exits without polling
- `--no-experimental` overrides the default and excludes experimental tests

### 2. Trigger the CI run

```bash
cd playwright && bun run scripts/agent-ci.ts <options>
```

Map the resolved options:
- Test case filter: `-t <case-name>`
- Experimental (default on): `--experimental`
- Branch: `-b <branch-name>`
- Xcode runner: `--xcode`
- Detach mode: `-d`

Examples:
- `/e2e` (on main, no context) → `bun run scripts/agent-ci.ts --experimental`
- `/e2e` (on branch `feat/phone`, after editing `phone-setup.md`) → `bun run scripts/agent-ci.ts --experimental -b feat/phone -t phone-setup`
- `/e2e hello-world` (on main) → `bun run scripts/agent-ci.ts --experimental -t hello-world`
- `/e2e --detach` (on branch `fix/bug`) → `bun run scripts/agent-ci.ts --experimental -b fix/bug -d`
- `/e2e --no-experimental` → `bun run scripts/agent-ci.ts`

### 3. Report

Before running, briefly state the resolved options (branch, test case, experimental) so the user can see what was inferred.

Once the command finishes (or is dispatched in detach mode), summarize:
- Whether the workflow was triggered successfully
- The branch, test case filter, and flags used
- A link to the running workflow
