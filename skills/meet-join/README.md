# meet-join

Google Meet join + transcription + voice/chat participation skill.

The skill entrypoint lives in [`SKILL.md`](./SKILL.md); skill-internal
architecture and the isolation rule are covered in
[`AGENTS.md`](./AGENTS.md).

## Docs

- [Live verification runbook](./docs/LIVE-VERIFICATION.md) — manual smoke
  tests for multi-party scrapers, streaming STT, barge-in, and
  consent-triggered auto-leave. Run these against a real Meet whenever
  you touch the bot, extension, audio ingest, or consent monitor.

## Performance on arm64 hosts

The bot image is built and run with `--platform linux/amd64` because
Meet's BotGuard accepts a plain-subprocess Chromium launch, and
Chromium for Linux/amd64 is the platform with the richest working set
of base-image packages (Debian ships a current `chromium` for amd64
but lags for arm64, and `google-chrome-stable` dropped
`--load-extension` support that the extension-based join architecture
depends on). On an arm64 host (Apple Silicon Mac, Graviton, Ampere)
the image therefore runs under qemu user-mode emulation, which
carries a meaningful CPU tax on bot-boot steps like Bun startup and
Chromium V8 initialization.

To quantify the overhead per image build and spot regressions, use
[`bot/scripts/bench-join-latency.sh`](./bot/scripts/bench-join-latency.sh)
(docs: [`bench-join-latency.md`](./bot/scripts/bench-join-latency.md)).
The script runs N container launches against a test Meet URL and
reports per-run CSV plus mean / median / p95 for two intervals:

- `booted_delta`: container start → `meet-bot booted` (PulseAudio up,
  pre-Chromium). Measures base container-startup + qemu interpreter
  warmup.
- `ready_delta`: container start → `meet-bot ready (meetingId=…)`
  (extension loaded, join command dispatched). Adds Chromium launch
  and Meet prejoin DOM time; the closest stdout proxy we have for
  "about to click Join".

### Baseline numbers

*To be filled in after a live smoke-test run on the reference dev
hardware (Apple Silicon M-series under macOS Docker Desktop with
qemu-user-static). Expect order-of-magnitude overhead on `booted_delta`
vs. a native amd64 host and 3–5× on `ready_delta`.*

```
# image=vellum-meet-bot:<tag> iterations=<n> meet_url=<test-room>
# booted_delta (start → meet-bot booted): n=<n> mean=<m>ms median=<m>ms p95=<m>ms
# ready_delta  (start → meet-bot ready):  n=<n> mean=<m>ms median=<m>ms p95=<m>ms
```

If the arm64 cost becomes a blocker (latency visible to the user, CI
runtime blowup, flaky smoke tests), the path forward is a native arm64
image: Chromium from an alternate source (e.g. `chromium-browser` via
`snap` is off the table in containers, but `playwright`-style chromium
builds or the `browser-use` community images ship arm64 variants).
That work is deliberately deferred until we have baseline numbers
showing it's worth the complexity.
