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
  questionId: string; // V2 questions.jsonl `question_id`
  ability: string; // V2 questions.jsonl `question_type` (one of the five abilities)
  question: string;
  answer: string; // gold answer, used by the GPT-4o judge
  questionDate?: string;
  trajectoryIds: string[]; // ordered haystack from haystacks/lme_v2_<tier>.json
}
```

This PR ships the loader and its fixture tests only. The two-conversation runner (`run-ingest-ask`), GPT-4o paper-faithful judge, and Phase 1 wiring land in subsequent PRs against the contract established here.
