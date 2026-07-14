# Telemetry — Agent Instructions

## Wire contract

`telemetry-wire.generated.ts` (in this directory) is generated from the platform's telemetry ingest serializers and auto-synced here on platform merges (the platform's `sync-telemetry-wire.yaml` workflow). **Never edit it by hand** — contract changes belong in `vellum-assistant-platform` at `django/app/assistant/self_hosted_local/serializers.py`.

`types.ts` is the override layer on top of it: simple events flow through `WireEventMap` without restating fields — they use the generated types directly, so their construction sites get excess-property/missing-field errors when the contract moves. Events where the daemon's type is intentionally richer live in `Overrides`, each pinned to the wire type by compile-time guards covering both drift directions: `_*Narrows` (daemon values stay wire-assignable — catches wire-side tightening) and `_*KeysExist` (the daemon emits no field the wire no longer declares — catches platform-side field removals/renames, which structural subtyping would otherwise let through silently). Daemon-only events live in `Extensions`. A red guard or a failing `types.test.ts` on a sync PR means the platform contract moved — reconcile the override to the new wire shape, don't loosen the guard.

Pre-flush validation (`telemetry-wire-validation.ts`) checks outgoing events against the wire schemas and logs any the server would silently drop; it is observability only and never blocks or mutates the batch.

## Adding a new event type starts platform-side, not here

The ingest endpoint silently skips events whose type has no registered serializer (the batch still 2xxes and the daemon acks away its outbox rows), so an emitter shipped before its platform serializer loses every event it records — pre-flush validation logs the drop but does not prevent it.

The full cross-repo checklist lives with the serializer registry it governs, in `vellum-assistant-platform` at `django/app/assistant/self_hosted_local/AGENTS.md` ("Adding a new telemetry ingest event type"). The daemon emitter is the **last** step — added only after the platform serializer has merged and the wire sync PR has landed here. A new emitter is an outbox store plus registration in `telemetry-event-sources.ts` (or a watermark source for high-volume tables); if the type previously existed daemon-only, also move it out of `Extensions` in `types.ts`.
