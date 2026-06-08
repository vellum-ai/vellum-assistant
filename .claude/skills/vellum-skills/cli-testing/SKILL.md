---
name: cli-testing
description: >
  Manually test a running Vellum assistant end-to-end purely from the CLI — no
  desktop app or web UI. Hatch an instance, send messages, watch the reply, and
  tear it down. Use when verifying assistant behavior, reproducing a bug, or
  smoke-testing a change without the macOS/web clients.
---

# CLI Testing — Exercise the Assistant End-to-End

Drive a real assistant from the terminal only. The `vellum` CLI (`cli/`, package
`@vellumai/cli`) manages instance lifecycle; `vellum message` / `vellum events`
exercise a running instance. See [`cli/AGENTS.md`](../../../../cli/AGENTS.md) and
the root [`README.md`](../../../../README.md) § CLI for command reference.

## 0. Prerequisites

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun + the linked `vellum` binary
vellum ps                            # sanity check the CLI resolves
```

If `vellum` is missing, run `./setup.sh` from the repo root once (installs deps,
links the `vellum` command). Docker must be running for the default flow below.

## 1. Provide an LLM provider key (from the environment)

Local-mode and Docker-mode instances need **one** LLM provider key. The CLI reads
it straight from the host environment — just export it before hatching/setup:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY / GEMINI_API_KEY /
                                      # FIREWORKS_API_KEY / OPENROUTER_API_KEY /
                                      # MINIMAX_API_KEY
```

In Devin sessions `ANTHROPIC_API_KEY` is typically already present in the
environment — check with `echo "${ANTHROPIC_API_KEY:0:7}"` before asking for one.
The CLI maps providers to env vars in
[`cli/src/shared/provider-env-vars.ts`](../../../../cli/src/shared/provider-env-vars.ts).

## 2. Hatch — default to a Docker hatch

**Always default to `--remote docker`.** It runs the assistant, gateway, and
credential-executor in isolated containers that mirror production, pulls
prebuilt platform images (no local build, so it's fast), and keeps the test off
your host process table. Reserve `--remote local` (§5) for the rare case where
Docker is unavailable.

```bash
vellum hatch --remote docker --name clitest -d
```

`-d` (detached) returns immediately but **defers provider credential setup**, so
push the key into the container next:

```bash
vellum setup --provider anthropic    # reads ANTHROPIC_API_KEY from the env and
                                      # saves it into the running assistant
# → "Anthropic API key saved to assistant from the environment."
```

> Running `vellum hatch --remote docker --name clitest` **without** `-d` stays
> attached and configures provider credentials automatically — but `-d` +
> `vellum setup` is the reliable scripted path.

## 3. Verify functionality

`vellum message` is async (returns a message id, not the reply). `vellum events`
streams the reply but is long-running, so background it, send, wait, then read:

```bash
( vellum events > /tmp/vel_events.log 2>&1 & )   # stream in background
sleep 2
vellum message "Reply with exactly: CLI_TEST_OK"
sleep 25                                          # let the assistant respond
pkill -f "vellum events"
grep -A1 "CLI_TEST_OK" /tmp/vel_events.log        # confirm the reply
```

A successful run shows your message echoed as `**You:** ...` followed by the
assistant's reply (`CLI_TEST_OK`) in the event log.

### Common verification commands

| Command | Purpose |
|---|---|
| `vellum ps` | List instances + health (`🟢 healthy`), id, runtime URL, cloud |
| `vellum message "<text>"` | Send a message (async; prints message id) |
| `vellum events` | Stream live events/replies (long-running — background it) |
| `vellum logs -n 100` | Last 100 log lines; add `-f` to follow, `-s assistant`/`-s gateway` to filter |
| `vellum client` | Interactive terminal chat session (manual exploration) |
| `vellum message --json "<text>"` | Raw JSON response (for scripted assertions) |

## 4. Tear down

```bash
vellum retire clitest --yes          # stops containers and removes the instance
```

`retire` is destructive (removes per-instance Docker volumes); always clean up
test instances when done.

## 5. Fallback: local mode (no Docker)

Only when Docker is unavailable. Runs the daemon + gateway as plain host
processes; configures the provider key automatically from the env at hatch time:

```bash
vellum hatch --name clitest          # defaults to --remote local
vellum message "Reply with exactly: CLI_TEST_OK"
# verify via the `vellum events` pattern above, then:
vellum retire clitest --yes
```
