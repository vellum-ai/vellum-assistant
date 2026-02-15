# ZERO_COPY Baseline (PR 1)

Status: deterministic test scenarios measured; end-to-end runbook capture pending manual execution.

## Scope

This baseline captures the current inline IPC behavior for `cu_observation` before any blob transport changes.

## End-to-End Runbook (Pending Manual Capture)

The plan calls for a live 20-step CU session capture. This requires running the macOS GUI app interactively and cannot be automated in CI or unit tests. The instructions below are preserved for manual execution.

### Fixed Scenario

Run this exact task in local macOS daemon mode (no socket forwarding) and let it execute at least 20 perceive/action steps.

Prompt:

```text
Open Safari, go to https://news.ycombinator.com, open the first story in a new tab, summarize the headline in one sentence, switch back to Hacker News, scroll down one page, and then respond with done.
```

### Capture Setup

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

### Metric Extraction

#### Observation JSON line size (daemon parse view)

```bash
jq -r 'select(.msg == "IPC_METRIC cu_observation_parse") | .payloadJsonBytes' ~/.vellum/data/logs/vellum.log > /tmp/zero-copy-line-bytes.txt
```

#### Swift screenshot sizes (raw + base64)

```bash
rg 'IPC_METRIC cu_observation_build' /tmp/zero-copy-swift.log > /tmp/zero-copy-build-lines.txt
```

#### Send -> daemon receive latency (same-machine clock)

```bash
rg 'IPC_METRIC cu_observation_send|IPC_METRIC cu_observation_daemon_receive' /tmp/zero-copy-swift.log ~/.vellum/data/logs/vellum.log
```

Use `sessionId` + `sequence` to pair rows.

### Runbook Results

**Not yet captured.** Fill these tables after running the manual scenario above. Compute real p50/p95 from the collected sample distribution (expect 20+ data points).

| Metric | p50 | p95 | Samples |
|---|---|---|---|
| Observation IPC JSON bytes | — | — | — |
| Send→recv latency (ms) | — | — | — |

## Deterministic Test Scenarios

Measured by `testBlobTransport_reducesPayloadSize` in `SessionTests.swift`. These are two fixed test cases with representative payload sizes, not percentiles from a sample distribution.

### Typical scenario (150KB screenshot + 5KB AX tree)

Representative of a normal CU step with a moderately-sized screenshot and small AX tree.

| Metric | Value |
|---|---|
| IPC JSON bytes | 405,073 |
| Screenshot raw bytes | 150,000 |
| Screenshot base64 bytes | 200,000 |

### Large scenario (300KB screenshot + 12KB AX tree)

Representative of a heavy CU step with a large screenshot and complex AX tree (exceeds 8KB blob threshold).

| Metric | Value |
|---|---|
| IPC JSON bytes | 812,073 |
| Screenshot raw bytes | 300,000 |
| Screenshot base64 bytes | 400,000 |

## Notes

- JSON byte counts are exact values from `JSONEncoder.encode()` output. The test constructs a `CuObservationMessage` with inline base64 screenshot + AX tree and measures the encoded JSON size.
- Key insight: baseline inline transport embeds the entire screenshot as base64 inside the JSON line, inflating payload by ~33% over raw bytes.
- Keep this baseline file immutable after capture. Post-change numbers go in `AFTER.md` (PR 9).
