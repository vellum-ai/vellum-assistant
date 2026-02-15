# Swarm Orchestration — Developer Guide

## Module Map

| Module | Path | Purpose |
|---|---|---|
| Types | `src/swarm/types.ts` | Core types: `SwarmRole`, `SwarmTaskNode`, `SwarmPlan`, `SwarmTaskResult`, `SwarmExecutionSummary` |
| Limits | `src/swarm/limits.ts` | `SwarmLimits` interface, hard ceilings, `resolveSwarmLimits()` clamping |
| Plan Validator | `src/swarm/plan-validator.ts` | `validateAndNormalizePlan()` — ID uniqueness, role validation, dependency checks, cycle detection (Kahn's algorithm) |
| Worker Backend | `src/swarm/worker-backend.ts` | `SwarmWorkerBackend` interface, `WorkerProfile` types, `getProfilePolicy()` |
| Worker Prompts | `src/swarm/worker-prompts.ts` | `buildWorkerPrompt()`, `parseWorkerOutput()` |
| Worker Runner | `src/swarm/worker-runner.ts` | `runWorkerTask()` — status callbacks, profile mapping, error handling |
| Router Prompts | `src/swarm/router-prompts.ts` | `ROUTER_SYSTEM_PROMPT`, `buildPlannerUserMessage()` |
| Router Planner | `src/swarm/router-planner.ts` | `generatePlan()`, `parsePlanJSON()`, `makeFallbackPlan()` |
| Orchestrator | `src/swarm/orchestrator.ts` | `executeSwarm()` — topological scheduling, bounded concurrency, retries |
| Synthesizer | `src/swarm/synthesizer.ts` | `synthesizeResults()` — LLM synthesis with markdown fallback |
| Tool | `src/tools/swarm/delegate.ts` | `swarm_delegate` tool — recursion guard, config integration, abort support |

## Role Definitions

| Role | Profile | Tool Access |
|---|---|---|
| `coder` | Full coding toolset | Read, write, edit, bash, web search |
| `researcher` | Read-only leaning | Read, search, web; no writes/edits |
| `reviewer` | Check-only | Read, search; no edits/writes |
| `general` | Backward compatible | All tools with existing approval flow |

## Limits and Hard Ceilings

| Parameter | Config Default | Hard Ceiling |
|---|---:|---:|
| `maxWorkers` | 3 | 6 |
| `maxTasks` | 8 | 20 |
| `maxRetriesPerTask` | 1 | 3 |
| `workerTimeoutSec` | 900 | (none) |

## Failure Modes

1. **Plan generation fails**: Falls back to a single `coder` task with the full objective.
2. **Worker task fails**: Retried up to `maxRetriesPerTask` times. If all retries fail, the task is marked `failed` and all transitive dependents are marked `blocked`.
3. **All tasks fail**: `isError: true` is returned to the model. The summary includes failure details.
4. **Backend unavailable** (no API key): Worker returns `{ success: false, failureReason: 'backend_unavailable' }`.
5. **Cycle detected in plan**: `validateAndNormalizePlan()` throws and the planner falls back to a single-task plan.

## Cancellation Behavior

- `swarm_delegate` checks `context.signal?.aborted` before planning and before execution.
- If aborted, returns `{ content: 'Cancelled', isError: true }` immediately.
- The agent loop's abort-race mechanism handles cancellation during tool execution.

## Debugging Checklist

1. **Swarm not triggering?** Check `config.swarm.enabled` is `true`.
2. **Plan too many/few tasks?** Inspect planner model output. Check `swarm.maxTasks` ceiling.
3. **Workers failing?** Check API key availability. Look for `backend_unavailable` in task results.
4. **Tasks blocked?** A dependency failed. Check the dependency chain in the plan.
5. **Synthesis missing?** Check `swarm.synthesizerModel` config. Fallback markdown is used if the LLM call fails.
6. **Tests**:
   - `bun test src/__tests__/swarm-plan-validator.test.ts`
   - `bun test src/__tests__/swarm-worker-runner.test.ts`
   - `bun test src/__tests__/swarm-router-planner.test.ts`
   - `bun test src/__tests__/swarm-orchestrator.test.ts`
   - `bun test src/__tests__/swarm-tool.test.ts`
   - `bun test src/__tests__/swarm-session-integration.test.ts`
