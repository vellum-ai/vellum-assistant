# Amazon Skill Runtime Notes

This skill uses `browser_*` tools for browser execution and `host_bash` for deterministic helper scripts.

## Transport policy

- Allowed browser transport: `browser_*` tools only.
- Forbidden transport: `assistant browser chrome relay` and any relay-backed subprocess calls.

## Helper script contract

All helper scripts support the same contract:

- Input (stdin JSON or `--input-json`):
  - `phase`: string
  - `context`: object
  - `extracted.text`: string
  - `extracted.links`: string[]
  - `snapshotHints`: string[]
  - `userIntent`: string
- Output:
  - `{ "ok": true, "data": ... }` on success
  - `{ "ok": false, "error": "..." }` on failure

Scripts may also expose convenience CLI flags for common flows (`--query`, `--text`, `--links`, etc.).

## Script inventory

- `scripts/amazon-intent.ts`: classify next workflow step.
- `scripts/amazon-parse-search.ts`: normalize search candidate rows.
- `scripts/amazon-parse-product.ts`: parse product details and variant hints.
- `scripts/amazon-parse-cart.ts`: parse cart items and totals.
- `scripts/amazon-checkout-sanity.ts`: validate checkout-readiness markers.

## Local QA

Run script tests from repo root:

```bash
bun test skills/amazon/scripts/__tests__/amazon-intent.test.ts \
  skills/amazon/scripts/__tests__/amazon-parse-search.test.ts \
  skills/amazon/scripts/__tests__/amazon-parse-product.test.ts \
  skills/amazon/scripts/__tests__/amazon-parse-cart.test.ts \
  skills/amazon/scripts/__tests__/amazon-checkout-sanity.test.ts
```

Fixture inputs used by parser tests are in `skills/amazon/scripts/__fixtures__/`.
