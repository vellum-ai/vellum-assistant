# @vellumai/evals

The **Vellum Personal-Intelligence Benchmark** — a decision instrument for plugin-shipping decisions and competitive benchmarking against other personal-intelligence agents.

Runs profiles (species + setup commands + initial workspace) against tests (memory, judgment, initiative, follow-through, communication, cross-context coherence, trust handling, life navigation), generates a report card, drives product decisions.

**Not a CI gate. Not a regression suite.** Runs in a developer's sandbox on demand.

## Quick start

```bash
cd evals
bun install
cp .env.example .env
# edit .env with your ANTHROPIC_API_KEY (required by the user simulator)

bun run src/cli.ts run \
  --profiles p1,p2 \
  --benchmark personal-intelligence \
  --filter timeline-recall \
  --label "baseline-after-cache-fix"

bun run src/cli.ts server
```

`--benchmark` defaults to `personal-intelligence`; omit `--filter` to run
every unit in the benchmark. `--label` tags every (profile, unit) execution
in the invocation with the same `sessionId`, so the report server can show
them as a single grouped run.

The legacy `--tests <ids>` flag is accepted as a deprecated alias for
`--filter <ids>` against the personal-intelligence benchmark.

## Commands

| Command                                                          | Description                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `evals run --profiles <ids> [--benchmark <id>] [--filter <ids>]` | Cartesian profile × benchmark-unit runner. `--label <text>` tags the run. |
| `evals benchmarks list`                                          | List available benchmarks with their unit noun and unit count.            |
| `evals export --session <id> --out <path>`                       | Export a report session as JSONL for diffing and notebooks.               |
| `evals server`                                                   | Local report-card server for `.runs` at `localhost:3005`.                 |

The report server is organized as a hierarchy:

- `/` – list of runs (sessions). One card per `evals run` invocation.
- `/sessions/<id>` – per-profile score aggregates and the list of tests.
- `/sessions/<id>/tests/<testId>` – per-profile summaries on that test.
- `/sessions/<id>/tests/<testId>/profiles/<profileId>` – execution detail
  with the metric card, transcript, container event log, and test-runner
  progress log for that specific run.

Use `evals export --session <id> --out runs/<label>.jsonl` when you want a
portable artifact for comparing eval runs outside the report server. The JSONL
contains the session summary, per-test aggregate rows, and per-profile execution
metric summaries without embedding full transcripts or raw event logs.

## Layout

```
evals/
├── src/
│   ├── cli.ts               # CLI entry — `evals <command>`
│   ├── index.ts             # Module entry — public TS API
│   ├── commands/run.ts      # `evals run` subcommand
│   └── lib/                 # Harness library modules
├── profiles/                # Committed profile definitions
│   ├── p1/
│   │   └── manifest.json
│   └── p2/
│       └── manifest.json
├── benchmarks/              # One subdirectory per benchmark
│   ├── personal-intelligence/
│   │   ├── manifest.json    # displayName + unitDirName + unitNoun
│   │   └── tests/           # Unit definitions (`unitDirName` per manifest)
│   │       └── timeline-recall/
│   │           ├── SPEC.md  # simulator briefing
│   │           └── metrics/ # (optional) per-metric `.ts` scorers
│   └── longmemeval-v2/
│       ├── manifest.json    # displayName + unitDirName + unitNoun
│       ├── data/            # gitignored; populate via `data/download.sh`
│       ├── items/           # virtual unit dir — items materialized by `src/loader.ts`
│       └── src/             # benchmark-local code (loader, fixtures, tests)
├── .env.example             # API key contract
├── package.json
└── AGENTS.md                # Conventions
```

## Profile

A profile lives at `profiles/<id>/`. The directory name is the profile id.

`manifest.json` declares species, optional version, and optional setup commands run after the agent is hatched and before the test starts.

```json
{
  "species": "vellum",
  "setup": ["assistant plugins install simple-memory"]
}
```

Run `evals profiles list` to see all committed profiles and their setup.

`workspace/` (optional) holds files dropped into the agent's workspace before the run starts.

## Benchmark

A benchmark lives at `benchmarks/<id>/`. The directory name is the benchmark id.

`manifest.json` declares display metadata and where its units live:

```json
{
  "displayName": "Personal Intelligence",
  "unitDirName": "tests",
  "unitNoun": "test"
}
```

- `displayName` — human-readable name shown in `evals benchmarks list` and help text.
- `unitDirName` — directory under the benchmark root holding individual units (e.g. `tests`, `items`, `questions`).
- `unitNoun` — singular noun for one unit (`test`, `item`, `question`); used in CLI output so each benchmark speaks its own vocabulary.

Run `evals benchmarks list` to see all committed benchmarks.

## Test

A test lives at `benchmarks/personal-intelligence/tests/<id>/`. The directory name is the test id. (Other benchmarks live as peers under `benchmarks/` and may use different unit names.)

`SPEC.md` briefs the simulator agent on the role it plays and how it should interact with the assistant. It does not describe assertion behavior.

`setup.ts` optionally exports deterministic setup commands. `metrics/` is a directory of `.ts` files. Each metric file exports a default scorer. Metrics receive a run id and call metric-library helpers such as readTranscript(runId), readAssistantEvents(runId), and readUsage(runId). Run artifacts are stored under .runs/<run-id>.
