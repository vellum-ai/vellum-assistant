# Notification Pipeline

All notification producers **MUST** go through `emitNotificationSignal()` in `notifications/emit-signal.ts`. Do not bypass the pipeline by broadcasting events directly -- the pipeline handles event persistence, deduplication, decision routing, and delivery audit.

When a notification flow creates a server-side conversation (e.g. guardian question conversations, task run conversations), the conversation and initial message **MUST** be persisted before the conversation-created event is emitted. This ensures the macOS/iOS client can immediately fetch the conversation contents when it receives the event.
