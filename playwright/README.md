# Playwright E2E Test Cases

## Overview

These test cases represent **happy path** scenarios, not edge cases. They verify that the core user flows work end-to-end as expected.

## Status Levels

Each test case has a `status` field in its frontmatter:

| Status | Meaning |
|---|---|
| `critical` | Blocks releases. Must pass before shipping. |
| `stable` | Runs during release, but won't block it. |
| `experimental` | Won't run during a release. |

## Running Tests

**Do not run test cases on your local machine.** There are two ways to run them:

### Option 1: Run via PR (recommended for testing new or changed cases)

1. Create a PR with your test case changes
2. Run the Playwright GitHub Action and point it to the test cases in your PR branch

### Option 2: Merge to main with `experimental` status

1. Set `status: experimental` in the test case frontmatter
2. Merge to main — experimental tests won't run during releases
3. Once validated, update the status to `critical` or `stable`

## GitHub Actions Workflow

Tests are run via the **"Run workflow"** button in GitHub Actions. The workflow runs from `Branch: main` by default and accepts the following inputs:

| Input | Description |
|---|---|
| **Release version** | Release version to test (e.g. `1.2.3`). If set, downloads the DMG from `vellum-ai/velly` releases instead of building from source. |
| **Run experimental tests** | Checkbox. When enabled, runs tests marked with `status: experimental` in front matter. |
| **Single test case name** | Run a single test case by name (e.g. `hello-world`). If empty, runs all tests. |
| **Use agent-xcode runner** | Checkbox. When enabled, uses the `agent-xcode` (AXUIElement) runner instead of the Playwright runner. |
| **Number of parallel shards** | Number of parallel shards (macOS runners) to split tests across. Each shard gets its own isolated runner. |
