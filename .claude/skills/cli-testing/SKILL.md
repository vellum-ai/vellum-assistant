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
exercise a running instance. See [`cli/AGENTS.md`](../../../cli/AGENTS.md) and
the root [`README.md`](../../../README.md) § CLI for command reference.

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
[`cli/src/shared/provider-env-vars.ts`](../../../cli/src/shared/provider-env-vars.ts).

## 2. Hatch — default to a Docker hatch built from source

**Always default to `--remote docker`.** It runs the assistant, gateway, and
credential-executor in isolated containers that mirror production and keep the
test off your host process table. Reserve `--remote local` (§5) for the rare
case where Docker is unavailable.

**Build from source — that's the point of testing.** A bare
`vellum hatch --remote docker` **pulls the published platform images** even when
the CLI itself runs from your checkout, so it would test released code, not your
changes. Source-build is opt-in via a flag
([`resolveDockerHatchMode` in `cli/src/lib/docker.ts`](../../../cli/src/lib/docker.ts)):

- `--source <path>` — build images **once** from the source tree at `<path>`, no
  watcher. **Default for testing:** picks up your current changes and is robust
  for a scripted one-shot run.
- `--watch` — build from source **and** start a file-watcher that rebuilds the
  affected image on change (watches each service's `src/`, `package.json`, and
  `Dockerfile`). Use while iterating. The watcher is a long-lived foreground
  process, so prefer `--source` for unattended/scripted runs.

```bash
vellum hatch --remote docker --source . --name clitest   # build from cwd
# → "Mode: build-from-source" then "Images (local build): vellum-assistant:local-clitest …"
```

> If `--source`/`--watch` is passed but no full source tree is found (e.g. the
> CLI is running from a packaged app bundle), the CLI falls back to pulling the
> published images and says so — watch for that line if you expect a build.
> Building all three images takes ~1–2 min the first time.

**Hatch attached — do not pass `-d`.** An attached hatch leases the guardian
token and configures the provider credential from your environment **inline**,
then returns once the containers are healthy — no follow-up `vellum setup`
needed. Detached mode (`-d`) defers the guardian-token lease, so a later
`vellum setup` cannot authenticate against the gateway and fails with an
`invalid_signature` 401. Confirm readiness with `vellum ps` (`🟢 healthy`)
before messaging.

## 3. Verify functionality

`vellum message` is async (returns a message id, not the reply — `--json` only
adds `{accepted, messageId}`). `vellum events` streams the reply but is
long-running, so background it, send, wait, then read.

**Assert on a token the assistant must *generate*, never one you put in the
prompt.** `vellum events` echoes your prompt as `**You:** <text>`
([`cli/src/commands/events.ts`](../../../cli/src/commands/events.ts)), so
grepping for a word that appears in the prompt passes even when the assistant
never replied. Ask a question whose answer is absent from the prompt:

```bash
( vellum events > /tmp/vel_events.log 2>&1 & )   # stream in background
sleep 2
vellum message "What is 6 multiplied by 7? Reply with only the number."
sleep 25                                          # let the assistant respond
pkill -f "vellum events"
grep -w 42 /tmp/vel_events.log                    # "42" is NOT in the prompt,
                                                  # so a match proves a real reply
```

The assistant's streamed reply is written as plain text (no `**You:**` prefix),
so a match on a generated answer confirms the round-trip worked. If you must use
a fixed sentinel string, strip the echoed prompt first
(`grep -v '^\*\*You:\*\*' /tmp/vel_events.log | grep <sentinel>`).

### Common verification commands

| Command | Purpose |
|---|---|
| `vellum ps` | List instances + health (`🟢 healthy`), id, runtime URL, cloud |
| `vellum message "<text>"` | Send a message (async; prints message id) |
| `vellum events` | Stream live events/replies (long-running — background it) |
| `vellum logs -n 100` | Last 100 log lines; add `-f` to follow, `-s assistant`/`-s gateway` to filter |
| `vellum client` | Interactive terminal chat session (manual exploration) |
| `vellum message --json "<text>"` | Send-ack as JSON (`{accepted, messageId}`) — the reply still arrives via `vellum events`, not here |

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
# verify via the `vellum events` + generated-answer pattern in §3, then:
vellum retire clitest --yes
```
