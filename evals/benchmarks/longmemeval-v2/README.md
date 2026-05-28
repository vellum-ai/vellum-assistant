# LongMemEval v2

The first public benchmark we run through the eval harness. 451 manually-curated questions and 1,870 task trajectories testing five memory abilities:

- **Static state recall** — remembers important landmarks and page layouts.
- **Dynamic state tracking** — understands how states change over time.
- **Workflow knowledge** — knows the steps needed for recurring tasks.
- **Environment gotchas** — recognizes recurring local failure modes.
- **Premise awareness** — detects assumptions valid elsewhere but wrong here.

Source: [LongMemEval-V2 paper (arXiv 2605.12493)](https://arxiv.org/abs/2605.12493) · [dataset on Hugging Face](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2) · Apache-2.0.

Integration spec: `/workspace/scratch/evals-longmemeval-v2-spec.md`.

## Layout

```
benchmarks/longmemeval-v2/
├── manifest.json              # displayName + unitDirName + unitNoun
├── README.md                  # this file
├── data/                      # 7+ GB dataset payload (gitignored)
│   ├── .gitignore
│   ├── download.sh            # huggingface-cli download wrapper
│   └── …                      # questions.jsonl, trajectories.jsonl,
│                              #   haystacks/lme_v2_{small,medium}.json,
│                              #   question_screenshots/, trajectory_screenshots/
├── items/                     # virtual unit dir — populated on demand by the loader
└── src/
    ├── loader.ts              # questions.jsonl + haystacks/<tier>.json → BenchmarkItem[]
    ├── trajectories.ts        # trajectories.jsonl → workspace file writes
    ├── runner.ts              # per-question runIngestAsk + evalFromSpec wiring
    ├── judge/                 # eval_function dispatcher (deterministic + LLM)
    └── __tests__/             # fixture-backed loader/trajectories/runner tests
```

## Getting the data

```bash
cd evals/benchmarks/longmemeval-v2/data
./download.sh
```

`download.sh` is idempotent. The dataset is 7.12 GB; the `data/` directory stays gitignored.

## Loader

`src/loader.ts` exports `loadLongMemEvalV2({ dataRoot, tier })`, returning an array of `BenchmarkItem`s:

```ts
interface BenchmarkItem {
  questionId: string; // V2 questions.jsonl `id` (stable question id)
  ability: string; // V2 questions.jsonl `question_type` (one of the five abilities)
  question: string;
  answer: string; // reference answer, used by the dispatched evaluator
  trajectoryIds: string[]; // ordered haystack from haystacks/lme_v2_<tier>.json
}
```

The V2 schema also ships `domain`, `environment`, `image`, and
`eval_function` fields (see `SCHEMA.md` in the published dataset). The
loader's zod schema preserves these via `.passthrough()`; the judge and
the runner consume them.

## Judge

`src/judge/index.ts` exports `evalFromSpec(spec, inputs, overrides?)` — a
TypeScript port of V2's `evaluation/qa_eval_metrics.py`. Each V2 question
carries an `eval_function` spec string of the form `"name|key=value|..."`
that dispatches to one of six implementations:

**Deterministic (no LLM):**

- `norm_phrase_set_match` — phrase-set membership (unordered)
- `norm_phrase_set_match_ordered` — phrase-set membership (ordered)
- `mc_choice_match` — single multiple-choice letter
- `mc_choice_set_match` — multi-select multiple-choice letters

**LLM judges** (default `gpt-5.2` with `reasoning_effort=medium`, per V2's
`run_eval.py` defaults):

- `llm_abstention_checker` — flawed-premise (abstention) questions
- `llm_gotchas_checker` — insight-style gotcha questions

Both LLM judges issue an OpenAI-shape chat completion with a strict
system prompt + rubric, expect `{"label": 0|1, "reason": "..."}` JSON
output, and tolerate Markdown code fences + regex-fallback parsing.
Transport is a direct `fetch` to the chat completions endpoint — tests
swap `globalThis.fetch`, no production wrapper.

`evalFromSpec` returns `{ label: boolean, reason: string, function: string }`.
`reason` is empty for deterministic evaluators; the function name is
echoed for audit/logging.

## Trajectories

`src/trajectories.ts` exports two pieces the runner depends on:

- `loadTrajectories(dataRoot)` — parses `trajectories.jsonl` into a
  `Map<string, TrajectoryRecord>` keyed by id, with line-numbered
  schema errors and duplicate-id rejection. The current implementation
  reads the entire file (~1 GB at the small tier) into memory once per
  `evals run` invocation; a streaming / indexed variant is tracked for
  the cache PR.
- `materializeWorkspaceFiles(item, trajectories)` — turns one
  `BenchmarkItem` + the trajectory map into the `WorkspaceFileWrite[]`
  the agent receives at ingest time. Layout the agent sees:

  ```
  longmemeval/
  ├── trajectories/
  │   ├── <trajectory_id_1>.json   # verbatim TrajectoryRecord
  │   ├── <trajectory_id_2>.json
  │   └── …                         # haystack order preserved
  └── manifest.json                  # { questionId, ability, question,
                                     #   trajectoryDir, trajectoryIds, count }
  ```

## Per-unit runner

`src/runner.ts` exports `runLongMemEvalV2Unit`. Lifecycle mirrors
`runEvalOnce`:

1. ensure run artifacts + write `run.json` with `status: "running"`
2. materialize trajectory files into the workspace
3. drive `runIngestAsk` — conversation A ingests the staged files,
   conversation B asks the verbatim question
4. dispatch `evalFromSpec(item.evalFunction, …)` against the hypothesis
5. write a coarse 3-turn transcript (ingest prompt → question prompt →
   assistant hypothesis), the question-turn `assistant-events.json`,
   and the single `longmemeval-v2-judge` metric
6. flip `run.json` to `status: "completed"` (or `"failed"` on throw)

Out of scope for the wire PR (deferred, not forgotten):

- extracting the artifact-lifecycle boilerplate (progress wrapper +
  heartbeat ticker) into a helper shared with `runEvalOnce` — flagged
  with `// PR-6 follow-up` markers in the source
- per-event transcript reconstruction + usage/cost telemetry — picked
  up alongside the cache + telemetry PR

## Running the benchmark

`evals run --benchmark longmemeval-v2 --profiles <id>` dispatches by
`benchmark.id` (not by a manifest field) — the V2 path runs the
two-conversation flow above; every other benchmark runs the
simulator-driven `runEvalOnce` path.

Operator surface (env vars):

| Variable                      | Default                          | Meaning                                                          |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `EVALS_LONGMEMEVAL_DATA_ROOT` | `benchmarks/longmemeval-v2/data` | Where `download.sh` wrote `questions.jsonl` etc.                 |
| `EVALS_LONGMEMEVAL_TIER`      | `small`                          | `small` (~115k tokens/haystack) or `medium` (~115M, memory-only) |

`--filter <ids>` selects a subset by V2 `question_id`. Omit to run every
question in the tier.

### Phase 1 smoke selection

The five-item smoke set used to validate the wire end-to-end covers
each `eval_function` family at least once. Pick IDs from
`questions.jsonl` whose `eval_function` matches one of:

| Family                          | Coverage role                         |
| ------------------------------- | ------------------------------------- |
| `norm_phrase_set_match`         | Default deterministic phrase grader   |
| `norm_phrase_set_match_ordered` | Ordered-phrase variant                |
| `mc_choice_match`               | Single multiple-choice letter         |
| `llm_abstention_checker`        | LLM judge — flawed-premise abstention |
| `llm_gotchas_checker`           | LLM judge — gotcha insight            |

Phase 2 expands to the full 451-question small tier once the cache PR
lands the indexed trajectory reader.

## Next

The cache PR (PR-7) is the next major step: indexed / streaming
`trajectories.jsonl` access so the full 451-Q small tier runs without
a ~1 GB upfront read per `evals run`, plus the shared artifact-lifecycle
helper extract called out above.
