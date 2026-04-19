# `bench-join-latency.sh`

Measures meet-bot join latency on an arm64 host running the amd64 bot image
under qemu emulation. Primary purpose: establish a baseline for how much
qemu overhead costs us per join so we can decide whether a native arm64
image is worth building, and so regressions in bot boot time show up in a
single CSV.

## Usage

```bash
BOT_IMAGE=vellum-meet-bot:latest \
  ./bench-join-latency.sh https://meet.google.com/xxx-yyyy-zzz 5
```

### Arguments

| Position | Name         | Default | Description                                    |
|----------|--------------|---------|------------------------------------------------|
| `$1`     | `MEET_URL`   | —       | Full Google Meet URL. Required.                |
| `$2`     | `ITERATIONS` | `5`     | Number of bot runs to average.                 |

### Environment

| Variable        | Default                | Description                                                                                                                                                                                         |
|-----------------|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `BOT_IMAGE`     | —                      | Container image reference. Required.                                                                                                                                                                |
| `MEETING_ID`    | generated per run      | Override the per-run meeting id. Normally the bench generates a fresh UUID per iteration so sessions don't collide.                                                                                 |
| `JOIN_NAME`     | `Bench Bot`            | Display name the bot presents in the prejoin UI.                                                                                                                                                    |
| `BENCH_TIMEOUT` | `120`                  | Per-iteration timeout in seconds. Covers worst-case cold-cache qemu boot + Chromium launch.                                                                                                         |
| `DAEMON_URL`    | `http://127.0.0.1:1/`  | Bot ingress URL. Intentionally defaulted to an unreachable address — the bench doesn't need events to land, only the bot to boot and dispatch the join. A real daemon would make the bench noisier. |

## Output

The script prints a CSV to stdout (header + one row per iteration) and
aggregate stats to stderr:

```csv
iteration,start_ms,booted_ms,ready_ms,total_ms,booted_delta_ms,ready_delta_ms
1,1713550000123,1713550004712,1713550011498,12031,4589,11375
2,1713550012200,1713550016344,1713550022881,10901,4144,10681
...
```

Aggregate stats are written to stderr and include `mean`, `median`, and
`p95` for each of:

- `booted_delta` — `start` → `meet-bot booted` (container cold-start +
  PulseAudio init; dominated by qemu interpreter startup + shared-library
  relocation).
- `ready_delta` — `start` → `meet-bot ready (meetingId=…)` (adds Xvfb,
  Chromium launch, extension load, and join-command dispatch).

## Markers & what they do/don't mean

The bot's lifecycle events (`lifecycle:joining`, `lifecycle:joined`) are
shipped to the daemon over HTTP rather than logged to stderr. For a
standalone bench where no daemon is running, we anchor on two stdout
lines the bot prints unconditionally:

| Marker string                      | Phase                                                                                                                                                                                       |
|------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `meet-bot booted`                  | PulseAudio is up. Pre-Xvfb, pre-Chromium.                                                                                                                                                   |
| `meet-bot ready (meetingId=…)`     | Extension loaded, HTTP server started, join command dispatched to the extension. Closest stdout proxy for "about to hit the admission button". Strictly earlier than `lifecycle:joined`.  |

If you instrument a real daemon receiving the bot's HTTP pipe and want
a true `start` → `lifecycle:joined` measurement, you'll want to extend
this script (or write a sibling) that tails the daemon's SSE stream for
`meet.joined` instead. For the arm64/qemu baseline, the bot-boot window
is the dominant cost and the right thing to chart.

## Interpreting numbers

On a native amd64 host, `booted_delta` should land in the low hundreds
of milliseconds and `ready_delta` in the 2–4 second range (mostly
Chromium startup + Meet prejoin DOM wait).

On an arm64 host under `--platform linux/amd64` qemu emulation, both
numbers grow substantially. The dominant cost is interpreter overhead
on CPU-heavy steps — Bun's startup, Chromium's V8 initialization, and
extension JS compilation. Expect roughly an order-of-magnitude slowdown
for `booted_delta`, and a 3–5x slowdown for `ready_delta` (because the
Meet prejoin DOM wait is I/O-bound and partially insulated from
emulation cost). Actual ratios depend on host chip (M1 vs M3, Graviton
vs Ampere), host load, and whether the image layers are warm in the
local Docker cache.

See `skills/meet-join/README.md` for baseline numbers captured on the
reference dev hardware.

## Caveats

- **Cold-cache first iteration.** The first iteration typically
  includes qemu register-bank setup and shared-library warmup. Bench
  runs with `iterations ≥ 3` and rely on the median rather than the
  mean when the first sample is visibly high.
- **Host load.** Chromium and Bun are CPU-bound under emulation, so a
  busy host machine skews latency sharply. Close other heavy apps
  before collecting a baseline.
- **Meet prejoin behavior varies.** Admission policies (guest knock-to-enter,
  in-domain auto-admit) change the DOM path the extension walks; use
  the same meeting type across runs when comparing numbers.
