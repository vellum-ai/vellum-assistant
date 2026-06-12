# evals/ — Personal-Intelligence Benchmark Harness

## Purpose

Decision instrument for plugin-shipping decisions on Vellum Assistant. Runs profiles (species + setup + initial workspace) against personal-intelligence tests, generates reports, drives product decisions.

Secondary: competitive benchmarking against OpenClaw, Claude Code, Codex, and Hermes via the same harness.

**Not a CI gate. Not a regression suite.** Runs in a developer's sandbox on demand.

## Scope

- OSS-from-day-one. Nothing here stays private.
- Native TypeScript. No upstream eval framework dependency; borrows Solver/Scorer/Task patterns from inspect-ai.
- Cost is a first-class scoring axis (tokens + API spend + latency).
- Local-dev-only sandbox while the harness is young; hosted execution is out of scope for this package.

## Architecture

**Run shape, parameterized cartesian:**

```
evals run --profiles <p1>[,<p2>...] [--benchmark <id>] [--filter <u1>[,<u2>...]]
```

Single (1×1), suite (1×M), ablation (N×1), full matrix (N×M). Same codepath. `--benchmark` defaults to `personal-intelligence`; omitting `--filter` runs every unit in the benchmark. `--tests <ids>` is a deprecated alias for `--filter` and emits a one-line warning.

**Benchmark:** declarative directory under `benchmarks/`. `manifest.json` declares `displayName`, `unitDirName` (directory holding units, e.g. `tests` for personal-intelligence, `items` for longmemeval-v2), and `unitNoun` (singular noun used in CLI output). Personal-Intelligence is a peer of every public benchmark we run.

**Profile:** declarative directory under `profiles/`. `manifest.json` declares species, optional version, optional setup commands. Optional `workspace/` subdirectory provides initial files for the agent. Plugins are installed via setup commands like `vellum exec -- assistant plugins install simple-memory`.

**Test (personal-intelligence unit):** declarative directory under `benchmarks/personal-intelligence/tests/<id>/`. `SPEC.md` briefs the simulator agent. Optional `metrics/` subdirectory holds per-metric `.ts` scorers. The on-disk root is resolved via `loadBenchmark("personal-intelligence").unitsDir` (or the legacy `getTestsDir()`, overridable via `EVALS_TESTS_DIR`). Other benchmarks define their own unit shape under their own `unitDirName`.

**Agent adapter (per species):** thin CLI process wrapper. Owns invocation, stdin/stdout format, and normalizing the species' native interaction model onto the shared `send` / `events()` contract. Each test gets a fresh process — no sharing across tests (parallelization-ready). The Vellum adapter hatches a fresh Docker instance, sends user messages via `vellum message`, and reads assistant output from a live `vellum events --json` SSE stream. The Hermes adapter has no streaming CLI: a turn is a single-shot `hermes -z "<prompt>"` that prints only the final answer, so `send` runs one shot per message and `events()` synthesizes a single `message_chunk` from its stdout. **Cross-turn state is the species' concern, not the adapter's** — Vellum resumes a conversation key, whereas each Hermes shot is stateless and continuity flows through Hermes's [memory subsystem](https://hermes-agent.nousresearch.com/docs) (files under `/opt/data/memories/` auto-loaded each shot); the adapter tracks no session ids between Hermes turns. The adapter does **not** own cost — see the egress jail below.

**Simulator:** LLM-driven user (Claude Haiku). Same model across all tests and species; represents any-possible-user generality. Seeded for pseudo-determinism.

**Egress jail:** Docker network layer. Vellum eval runs use a pre-created internal Docker network plus a dual-homed HTTP CONNECT proxy sidecar. The assistant receives proxy env vars at hatch time, so outbound model traffic flows through the allowlist proxy while integrations remain blocked by default.

Also the **cost/usage authority.** The proxy parses token counts out of the observed model responses and the harness prices them locally, so cost reflects real traffic and can't be spoofed by an adapter or assistant choosing what to emit. Assistant-side usage must come from `readUsageRecords()` — never from emitted events. (Harness-owned calls like the LLM judge are not assistant traffic, so they price from their own usage.)

**Report card:** JSONL — one row per (profile × test × run). Static HTML report rendered alongside.

## Conventions

- **CLI entry:** `src/cli.ts`. Subcommands live in `src/commands/<name>.ts` and export `register<Name>Command(program)` (commander). New subcommands register themselves on the root program in `cli.ts`.
- **Public module API:** `src/index.ts`. Importing the package root never runs the CLI.
- **Adapters:** shared interface in `src/lib/adapter.ts`; species implementations in `src/lib/adapters/`. Keep adapters CLI-boundary-oriented rather than importing CLI internals.
- **Egress:** Docker jail helpers live in `src/lib/egress/`. Keep policy testable without requiring Docker in unit tests.
- **Schemas:** zod, co-located with their loader in `src/lib/*.ts`.
- **Benchmark/Profile/Test ids:** lowercase alphanumeric + hyphens (`^[a-z0-9][a-z0-9-]*$`). Match the directory name.
- **Benchmark loader:** prefer `loadBenchmark(id).unitsDir` for new code. `getTestsDir()` / `listTestIds()` stay as personal-intelligence shortcuts for legacy callers and the back-compat `evals tests list` surface.
- **Environment:** `.env` (gitignored) — copy from `.env.example`.
- **Test fixtures:** committed in-repo for reproducibility.
- **Each test runs in its own fresh agent process.** No sharing — parallelization-ready by construction.

## What does NOT belong here

- Vellum runtime code, plugin sources, skill definitions — those live in `assistant/`, `plugins/`, `skills/`.
- CI infrastructure or release tooling — this is a sandbox-only harness.
- Anything not directly serving the "run a profile × test combo and emit a report row" mission.
