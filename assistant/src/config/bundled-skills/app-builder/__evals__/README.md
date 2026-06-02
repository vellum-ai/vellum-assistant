# app-builder eval / golden-set harness

A standalone harness for measuring whether a change to the app-builder flow
improves taste and latency, instead of guessing. It runs a fixed set of prompts
through one or more **build variants** and emits an A/B-comparable **scorecard**.

The immediate motivation is app-builder v2 (a tiered planner/worker flow). This
harness lets us baseline the current **single-model** skill now, then A/B it
against the **planner/worker** flow once that lands.

> This is **not** wired into the default test / CI gate. It is meant to be run
> by hand when evaluating a change.

## What it measures

Per build (one prompt under one variant), three independent dimensions:

| Dimension          | What it checks                                                               | Where               |
| ------------------ | ---------------------------------------------------------------------------- | ------------------- |
| **compile**        | Did the produced source compile?                                             | `runner.ts`         |
| **plan-adherence** | Did the output use the expected design tokens / files? (static, best-effort) | `plan-adherence.ts` |
| **design rubric**  | LLM-scored aesthetic/quality judgment                                        | `rubric.ts`         |

These roll up into a `Scorecard` (`types.ts`) with one column per variant and
columns reserved for **latency** and **cost** — to be filled in by PR 7
telemetry.

## Run it

```bash
cd assistant
bun run src/config/bundled-skills/app-builder/__evals__/index.ts
```

Prints a scorecard table. Out of the box both columns use a deterministic
**stub** build driver and a **stub** design judge, so the numbers are
placeholders that prove the pipeline runs end-to-end.

Run the smoke test:

```bash
cd assistant
bun test src/config/bundled-skills/app-builder/__evals__/__tests__/harness.test.ts
```

## Files

- `prompts.ts` — the fixed golden prompt set (habit tracker, finance dashboard,
  slide deck, calculator). **Append-only** — editing existing prompts breaks
  comparability across runs.
- `types.ts` — shared types and the two key interfaces: `AppBuildDriver` and
  `DesignJudge`.
- `build-driver.ts` — `AppBuildDriver` impls. Ships `StubBuildDriver`; real
  single-model and planner/worker drivers slot in here.
- `rubric.ts` — the design rubric, the LLM-judge interface (`LLMDesignJudge`),
  and `StubDesignJudge`.
- `plan-adherence.ts` — best-effort static token/file checks.
- `runner.ts` — drives builds, scores them, aggregates the scorecard. Compile
  and judge steps are injectable.
- `index.ts` — CLI entry + scorecard formatter.

## Wiring real signal (later)

The harness depends only on the `AppBuildDriver` and `DesignJudge` interfaces,
so making it real is a matter of swapping stubs for live impls:

1. **Live build driver** — implement `AppBuildDriver.build()` to run the actual
   app-builder skill (single-model) and the planner/worker flow, returning the
   real source files (and the planner/worker's committed plan).
2. **Live design judge** — implement `DesignJudge.score()` to render the built
   app, send `buildJudgePrompt()` + a screenshot to a model, and parse the
   rubric scores (`scoreToOverall()` does the weighting).
3. **Real compile** — pass `compile` to `runEvals` backed by the esbuild
   `compileApp` from `assistant/src/bundler/app-compiler.ts`.
4. **Telemetry** — populate `BuildResult.telemetry` (latency/cost) once PR 7
   lands; the scorecard already has the columns.
