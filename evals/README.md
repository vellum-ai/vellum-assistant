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
  --tests t1

bun run src/cli.ts server
```

## Commands

| Command                                    | Description                                               |
| ------------------------------------------ | --------------------------------------------------------- |
| `evals run --profiles <ids> --tests <ids>` | Cartesian profile × test runner.                          |
| `evals server`                             | Local report-card server for `.runs` at `localhost:3005`. |

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
├── tests/                   # Committed test definitions
│   └── timeline-recall/
│       ├── SPEC.md          # simulator briefing
│       └── metrics/         # (optional) per-metric `.ts` scorers
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

## Test

A test lives at `tests/<id>/`. The directory name is the test id.

`SPEC.md` briefs the simulator agent on the role it plays and how it should interact with the assistant. It does not describe assertion behavior.

`setup.ts` optionally exports deterministic setup commands. `metrics/` is a directory of `.ts` files. Each metric file exports a default scorer. Metrics receive a run id and call metric-library helpers such as readTranscript(runId), readAssistantEvents(runId), and readUsage(runId). Run artifacts are stored under .runs/<run-id>.
