# Notification Pipeline

All notification producers **MUST** go through `emitNotificationSignal()` in `notifications/emit-signal.ts`. Do not bypass the pipeline by broadcasting events directly -- the pipeline handles event persistence, deduplication, decision routing, and delivery audit.

## Every notification ships with a user action

**No action, no notification.** Before adding a source event name, answer: could the user do anything differently because of it? If not, it is a log line, a status, or nothing, and it goes to one of the surfaces built for those instead:

| It is | Where it goes |
| --- | --- |
| Async work with a lifecycle | A **run** (`runs/run-store.ts`). One row, rewritten in place. Only `needs_input`, `failed`, and a notable success re-enter this pipeline |
| A subsystem failing repeatedly | A **System health** counter (`home/system-health.ts`). It counts, it never pushes, and it clears itself after a run of successes |
| A lifecycle transition nobody can act on | A log line |

Anything that fires repeatedly for the same underlying cause must collapse into a counter rather than sending again. Per-failure notifications for background jobs, plugin schedules, and channel webhooks were the majority of the bell's volume and are gone; do not reintroduce the shape under a new event name.

## Bucket, not priority

`notifications/bucket.ts` derives which of the three sections a signal lands in (`needs_you` / `worth_knowing` / `activity`) from fixed rules, **before** the decision engine runs. The model keeps channel selection and wording; it has no say in importance, which has to be predictable for the sections to mean anything.

`priority`, `noteworthy`, and `category` still ride the wire, but only as projections of the bucket (`bucketCompat`) for clients built against the pre-bucket contract. Nothing derives them independently. Do not add a fourth ranking dimension, and do not read them in new client code.

## Titles are written, never derived

A row's headline comes from the producer, the decision engine, or the written per-event headline in `home/feed-headline.ts`. Nothing slices a title off the front of a body: that is where rows reading like the truncated middle of a sentence came from. `notifications/copy-contract.ts` enforces the rest as a pre-send pass, repairing what it can (a first-person title, a title that is only the opening of the body, a raw error constant) and rejecting only copy with no usable body.

Guardian-request cards (approvals, questions) ride this pipeline end to end -- the full lifecycle map is [docs/guardian-request-flow.md](../../docs/guardian-request-flow.md). Card actions (`actions[]`) are built **once, centrally** in the broadcaster's context resolvers (`resolveApprovalContext` / `resolveQuestionOptionsContext`); channel adapters render only. Adding buttons for a new request kind = a broadcaster context branch, never adapter parsing.

When a notification flow creates a server-side conversation (e.g. guardian question conversations, task run conversations), the conversation and initial message **MUST** be persisted before the conversation-created event is emitted. This ensures the macOS/iOS client can immediately fetch the conversation contents when it receives the event.

Guardian-request producers (access requests, tool approvals, tool-grant escalations, voice questions, trusted-contact confirmations) **MUST** record approval-card deliveries through `recordApprovalCardDelivery` / `recordGuardianRequestDeliveries` in `guardian-delivery-recorder.ts` -- never by calling the gateway client's `createGuardianRequestDelivery` directly. That sink is the single place the card-to-request addressing convention lives (conversation id for the in-app card; chat + channel-native `ts` for channel cards), so the path that writes a delivery row cannot drift from the paths that read it back to withdraw a card or resolve an emoji reaction -- the drift that previously fanned this logic into four divergent copies. (Tests may seed delivery rows directly for fixtures.)

Approval-card **source references** (the link back to the channel message that triggered a request) resolve only through `resolveApprovalSourceReference()` in `runtime/approval-source-link.ts` -- producers spread the result into the `guardian.question` context payload and never hand-build links. Channel-format knowledge (id shapes, permalinks, mrkdwn) lives only in `messaging/providers/<channel>/` and `notifications/adapters/<channel>`; the four-layer ownership map is documented at the top of `approval-source-link.ts`. Exception: access-request cards predate the registry and still derive their Slack permalink from payload `messageTs` in `access-request-copy.ts` -- converge them onto the registry rather than adding a third resolution path.

Guardian-request card rows are **not conversation history**. `pairDeliveryWithConversation` persists a message row per delivery, and for a guardian card that row is addressed to a conversation the request is _about_ (the vellum card is pinned to the originating conversation; a channel card lands in whatever conversation the guardian's chat binds to). `isGuardianCardRow` in `approval-card-data.ts` is the single definition of which rows those are, derived from the card's own `ui_surface` id rather than a stored marker so old rows need no backfill. **Both** history assemblers must consult it -- `Conversation.loadFromDb` and `loadSlackChronologicalContext`, which re-reads rows rather than using `this.messages` -- or the unfiltered one replays the card between a parked turn's `tool_use` and its `tool_result` and history repair destroys the real result. Surface state is exempt on purpose: the card's buttons must still route after a restart. Full rationale in [docs/guardian-request-flow.md](../../docs/guardian-request-flow.md).
