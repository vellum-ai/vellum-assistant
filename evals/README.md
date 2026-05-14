# @vellumai/evals

The **Vellum Personal-Intelligence Benchmark** — a decision instrument for plugin-shipping decisions and competitive benchmarking against other personal-intelligence agents.

Runs profiles (species + plugin combinations + initial state) against tests (memory, judgment, initiative, follow-through, communication, cross-context coherence, trust handling, life navigation), generates a report card, drives product decisions.

**Not a CI gate. Not a regression suite.** Runs in a developer's sandbox on demand.

## Quick start

```bash
cd evals
bun install
cp .env.example .env
# edit .env with your ANTHROPIC_API_KEY (used by the simulator from PR-3 onward)

bun run src/index.ts run \
  --profiles vellum-bare \
  --tests mem.single_turn.timeline_recall
```

In v0.1 PR-1 (this commit) the command above is a **dry-run** — it validates that profile and test definitions load against their schemas, and prints what it would run. Execution lands in PR-2 (adapter + egress jail) and PR-3 (simulator + scorer).

## Commands

| Command                                    | Description                                        |
| ------------------------------------------ | -------------------------------------------------- |
| `evals run --profiles <ids> --tests <ids>` | Cartesian product runner. v0.1 PR-1: dry-run only. |

More subcommands (`report`, `doctor`) ship as the harness builds out.

## Layout

```
evals/
├── src/
│   ├── index.ts             # CLI entry — `evals <command>`
│   ├── commands/run.ts      # `evals run` subcommand
│   ├── lib/profile.ts       # Profile Zod schema + loader
│   ├── lib/test-def.ts      # Test-definition Zod schema + loader
│   └── lib/__tests__/       # Unit tests
├── profiles/                # Committed profile definitions
│   └── vellum-bare.json
├── tests/                   # Committed test definitions
│   └── mem.single_turn.timeline_recall.json
├── .env.example             # API key contract
├── package.json
└── AGENTS.md                # Conventions and build status
```

## Status

v0.1 build-out — see `AGENTS.md` for the PR-by-PR plan.
