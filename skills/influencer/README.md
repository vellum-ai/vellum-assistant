# Influencer Skill Runtime Notes

This skill uses `browser_*` tools for navigation/extraction and `host_bash` helper scripts for deterministic parsing and ranking.

## Transport policy

- Allowed browser transport: `browser_*` tools only.
- Forbidden transport: `assistant browser chrome relay` and relay-backed subprocess clients.

## Helper script contract

All helper scripts support:

- Input (stdin JSON or `--input-json`):
  - `phase`: string
  - `context`: object
  - `extracted.text`: string
  - `extracted.links`: string[]
  - `snapshotHints`: string[]
  - `userIntent`: string
- Output:
  - `{ "ok": true, "data": ... }`
  - `{ "ok": false, "error": "..." }`

## Script inventory

- `scripts/influencer-intent.ts`: classify next workflow step.
- `scripts/influencer-parse-candidates.ts`: parse raw platform output to profile candidates.
- `scripts/influencer-theme-extract.ts`: infer content themes from bio/query.
- `scripts/influencer-score.ts`: score/filter candidates against criteria.
- `scripts/influencer-compare.ts`: produce ranked shortlist output.

## Local QA

Run script tests from repo root:

```bash
bun test skills/influencer/scripts/__tests__/influencer-theme-extract.test.ts \
  skills/influencer/scripts/__tests__/influencer-score.test.ts \
  skills/influencer/scripts/__tests__/influencer-parse-candidates.test.ts \
  skills/influencer/scripts/__tests__/influencer-compare.test.ts \
  skills/influencer/scripts/__tests__/influencer-intent.test.ts
```

Fixture inputs used by parser tests are in `skills/influencer/scripts/__fixtures__/`.
