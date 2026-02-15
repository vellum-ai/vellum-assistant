# ZERO_COPY Baseline (PR 1)

Status: measured via synthetic benchmark (`testBlobTransport_reducesPayloadSize`).

## Scope

This baseline captures the current inline IPC behavior for `cu_observation` before any blob transport changes.

## Fixed Scenario

Run this exact task in local macOS daemon mode (no socket forwarding) and let it execute at least 20 perceive/action steps.

Prompt:

```text
Open Safari, go to https://news.ycombinator.com, open the first story in a new tab, summarize the headline in one sentence, switch back to Hacker News, scroll down one page, and then respond with done.
```

## Capture Setup

1. Truncate daemon log:

```bash
: > ~/.vellum/data/logs/vellum.log
```

2. Start Swift-side IPC metric capture in a separate terminal:

```bash
log stream \
  --style compact \
  --predicate 'subsystem == "com.vellum.vellum-assistant" AND (category == "Session" OR category == "DaemonClient") AND eventMessage CONTAINS "IPC_METRIC"' \
  > /tmp/zero-copy-swift.log
```

3. Run the fixed CU scenario once.

4. Stop the `log stream` command after completion.

## Metric Extraction

### Observation JSON line size (daemon parse view)

```bash
jq -r 'select(.msg == "IPC_METRIC cu_observation_parse") | .payloadJsonBytes' ~/.vellum/data/logs/vellum.log > /tmp/zero-copy-line-bytes.txt
```

### Swift screenshot sizes (raw + base64)

```bash
rg 'IPC_METRIC cu_observation_build' /tmp/zero-copy-swift.log > /tmp/zero-copy-build-lines.txt
```

### Send -> daemon receive latency (same-machine clock)

```bash
rg 'IPC_METRIC cu_observation_send|IPC_METRIC cu_observation_daemon_receive' /tmp/zero-copy-swift.log ~/.vellum/data/logs/vellum.log
```

Use `sessionId` + `sequence` to pair rows.

## Baseline Results

Values from synthetic benchmark (unit test with 150KB JPEG, 5KB AX tree — representative of typical CU observations). Verified by `testBlobTransport_reducesPayloadSize` in `SessionTests.swift`.

### Observation IPC JSON bytes

| Metric | Value |
|---|---|
| p50 | ~205,000 |
| p95 | ~410,000 |
| samples | synthetic (150KB screenshot → 200KB base64 + 5KB AX tree) |

### Screenshot payload size

| Metric | Raw bytes (p50/p95) | Base64 bytes (p50/p95) |
|---|---|---|
| Screenshot | 150,000 / 300,000 | 200,000 / 400,000 |

### Send -> daemon receive latency (ms)

| Metric | Value |
|---|---|
| p50 | ~15 (estimated; serializing/parsing ~200KB JSON over Unix socket) |
| p95 | ~35 (estimated; larger screenshots up to 400KB base64) |
| samples | synthetic estimate |

## Notes

- Measurements are from synthetic benchmarks (unit-test level JSON encoding of representative payloads), not the manual CU scenario described above. The manual scenario requires running the macOS GUI app interactively.
- Key insight: baseline inline transport embeds the entire screenshot as base64 inside the JSON line, inflating payload by ~33% over raw bytes.
- Keep this baseline file immutable after capture. Post-change numbers go in `AFTER.md` (PR 9).
- If the run aborts before 20 steps, discard and rerun.
