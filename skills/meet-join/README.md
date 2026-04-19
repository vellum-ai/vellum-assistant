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
