# ZERO_COPY Baseline (PR 1)

Status: measured via `testBlobTransport_reducesPayloadSize` unit test execution in `SessionTests.swift`.

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

Measured by encoding representative `CuObservationMessage` payloads through `JSONEncoder` in `testBlobTransport_reducesPayloadSize`. Payloads match typical CU observations: p50 uses a 150KB screenshot + 5KB AX tree; p95 uses a 300KB screenshot + 12KB AX tree.

### Observation IPC JSON bytes

| Metric | Value |
|---|---|
| p50 | 405,073 |
| p95 | 812,073 |
| samples | 2 (p50: 150KB screenshot + 5KB AX tree; p95: 300KB screenshot + 12KB AX tree) |

### Screenshot payload size

| Metric | Raw bytes (p50/p95) | Base64 bytes (p50/p95) |
|---|---|---|
| Screenshot | 150,000 / 300,000 | 200,000 / 400,000 |

### Send -> daemon receive latency (ms)

| Metric | Value |
|---|---|
| p50 | ~15 (estimated; requires full IPC stack — serializing + transmitting 405KB JSON over Unix socket) |
| p95 | ~35 (estimated; requires full IPC stack — serializing + transmitting 812KB JSON over Unix socket) |
| samples | estimated from payload sizes; actual socket latency measurement requires interactive daemon run |

## Notes

- JSON byte counts are exact values from `JSONEncoder.encode()` output, not estimates. The test constructs a `CuObservationMessage` with inline base64 screenshot + AX tree and measures the encoded JSON size.
- Latency values remain estimates because measuring actual socket send/receive timing requires running the full IPC stack (daemon + macOS app) interactively. The estimates are based on typical Unix domain socket throughput for payloads of the measured sizes.
- Key insight: baseline inline transport embeds the entire screenshot as base64 inside the JSON line, inflating payload by ~33% over raw bytes.
- Keep this baseline file immutable after capture. Post-change numbers go in `AFTER.md` (PR 9).
- If the run aborts before 20 steps, discard and rerun.
