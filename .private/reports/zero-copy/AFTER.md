# ZERO_COPY After (Post-Implementation)

Status: deterministic test scenarios measured; end-to-end runbook capture pending manual execution.

## Scope

This captures the blob transport IPC behavior for `cu_observation` after all zero-copy changes are merged.

## End-to-End Runbook (Pending Manual Capture)

The plan calls for a live 20-step CU session capture. This requires running the macOS GUI app interactively and cannot be automated in CI or unit tests. Run the same scenario as BASELINE.md.

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
  > /tmp/zero-copy-after-swift.log
```

3. Run the fixed CU scenario once.

4. Stop the `log stream` command after completion.

### Metric Extraction

#### Observation JSON line size (daemon parse view)

```bash
jq -r 'select(.msg == "IPC_METRIC cu_observation_parse") | .payloadJsonBytes' ~/.vellum/data/logs/vellum.log > /tmp/zero-copy-after-line-bytes.txt
```

#### Swift screenshot sizes (raw + blob)

```bash
rg 'IPC_METRIC cu_observation_build' /tmp/zero-copy-after-swift.log > /tmp/zero-copy-after-build-lines.txt
```

#### Send -> daemon receive latency (same-machine clock)

```bash
rg 'IPC_METRIC cu_observation_send|IPC_METRIC cu_observation_daemon_receive' /tmp/zero-copy-after-swift.log ~/.vellum/data/logs/vellum.log
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

With blob transport enabled, screenshots are written to `~/.vellum/data/ipc-blobs/` as raw bytes and replaced with a small `IPCIpcBlobRef` in the JSON. AX trees exceeding 8KB are also blob-transported.

### Typical scenario (150KB screenshot + 5KB AX tree)

Screenshot is blob-transported; AX tree stays inline (below 8KB threshold). JSON contains the AX tree text + a small blob ref (~100 bytes).

| Metric | Value |
|---|---|
| IPC JSON bytes | 5,237 |
| Screenshot on disk | 150,000 (raw bytes, no base64 inflation) |

### Large scenario (300KB screenshot + 12KB AX tree)

Both screenshot and AX tree are blob-transported (AX tree exceeds 8KB threshold). JSON contains only two small blob refs.

| Metric | Value |
|---|---|
| IPC JSON bytes | 388 |
| Screenshot on disk | 300,000 (raw bytes, no base64 inflation) |
| AX tree on disk | 12,000 (UTF-8 bytes) |

Note: the large scenario produces a *smaller* JSON payload than the typical scenario because both payloads are offloaded to blobs, leaving only metadata in the JSON. In the typical scenario, the 5KB AX tree stays inline.

## Comparison with Baseline (Test Scenarios)

| Metric | Baseline | After | Reduction |
|---|---|---|---|
| IPC JSON bytes (typical) | 405,073 | 5,237 | 98.7% |
| IPC JSON bytes (large) | 812,073 | 388 | >99.9% |
| Screenshot in IPC (typical) | 200,000 (base64) | 0 (blob ref only) | 100% offloaded |
| Screenshot on disk (typical) | — | 150,000 (raw) | 25% smaller than base64 |

## Notes

- JSON byte counts are exact values from `JSONEncoder.encode()` output. The test constructs `CuObservationMessage` payloads with blob refs (instead of inline base64 screenshots) and measures the encoded JSON size.
- Blob files on disk contain raw bytes (no base64 inflation), eliminating the ~33% overhead of inline transport.
- The "large" scenario JSON (388 bytes) is smaller than the "typical" scenario JSON (5,237 bytes) because in the large case, *both* screenshot and AX tree are blob-transported, while in the typical case the 5KB AX tree stays inline in the JSON.
- Compare directly with `BASELINE.md` test scenario values.
