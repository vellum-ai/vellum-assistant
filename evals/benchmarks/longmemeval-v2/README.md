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
    └── __tests__/             # fixture-backed loader tests
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

## Next

The two-conversation runner (`run-ingest-ask`, shipped in PR #32356) and
this judge unblock Phase 1 wiring (5-item smoke against
`vellum-simple-memory`), which lands in a follow-up PR.
