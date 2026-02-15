# Swarm Smoke Benchmark Runbook

Repeatable scenarios for validating swarm orchestration performance and correctness.

## Prerequisites

```bash
cd assistant
export PATH="$HOME/.bun/bin:$PATH"
```

Ensure `config.swarm.enabled = true` and a valid Anthropic API key is configured.

## Scenario 1: Single-Task Baseline

**Purpose**: Verify a simple objective produces a single-task plan and completes without errors.

**Prompt**:
> "Write a hello-world TypeScript function"

**Expected behavior**:
- Plan: 1 task (coder role)
- No retries, no blocked tasks
- Result includes function output
- Duration: < 60s

**Validation**:
- `stats.completed === 1`
- `stats.failed === 0`
- `stats.blocked === 0`
- `isError === false`

## Scenario 2: Parallel Multi-Task

**Purpose**: Verify independent tasks run in parallel, bounded by `maxWorkers`.

**Prompt**:
> "Research the current TypeScript best practices, write a utility library with 3 functions, and write unit tests for the library"

**Expected behavior**:
- Plan: 3 tasks (researcher + coder + reviewer/coder)
- Researcher and initial coder can run in parallel
- Test task may depend on coder task
- Duration: less than 3x single-task time (parallelism benefit)

**Validation**:
- `stats.totalTasks === 3`
- `stats.completed >= 2`
- Progress events stream in real time

## Scenario 3: Failure and Retry

**Purpose**: Verify retry logic and dependent task blocking.

**Setup**: Temporarily set `swarm.maxRetriesPerTask = 1` in config.

**Prompt** (with intentionally difficult task):
> "Connect to a non-existent API at http://localhost:99999 and fetch data, then summarize the results"

**Expected behavior**:
- Connection task fails
- Retry attempted (1 retry)
- Summary task blocked (depends on connection task)
- Final result shows failure details

**Validation**:
- `stats.failed >= 1`
- `stats.blocked >= 0` (dependent tasks)
- `isError === true` if all tasks fail
- Error details in result content

## Scenario 4: Disabled Mode

**Purpose**: Verify graceful behavior when swarm is disabled.

**Setup**: Set `config.swarm.enabled = false`.

**Expected behavior**:
- Tool returns: "Swarm orchestration is disabled in config"
- `isError === false`
- No workers spawned

## Scenario 5: Abort During Execution

**Purpose**: Verify cancel propagates cleanly.

**Steps**:
1. Start a swarm with a multi-task objective
2. Cancel the session while workers are running

**Expected behavior**:
- Tool returns `{ content: 'Cancelled', isError: true }` or the abort races through the agent loop
- No hanging workers
- Session can accept new messages after cancel

## Recording Results

For each scenario, record:

| Metric | Value |
|---|---|
| Date | |
| Config (maxWorkers / maxTasks) | |
| Plan task count | |
| Completed / Failed / Blocked | |
| Wall-clock duration (ms) | |
| Notes | |
