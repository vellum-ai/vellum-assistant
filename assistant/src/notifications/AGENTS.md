# Notification Pipeline

All notification producers **MUST** go through `emitNotificationSignal()` in `notifications/emit-signal.ts`. Do not bypass the pipeline by broadcasting events directly -- the pipeline handles event persistence, deduplication, decision routing, and delivery audit.

Guardian-request cards (approvals, questions) ride this pipeline end to end -- the full lifecycle map is [docs/guardian-request-flow.md](../../docs/guardian-request-flow.md). Card actions (`actions[]`) are built **once, centrally** in the broadcaster's context resolvers (`resolveApprovalContext` / `resolveQuestionOptionsContext`); channel adapters render only. Adding buttons for a new request kind = a broadcaster context branch, never adapter parsing.

When a notification flow creates a server-side conversation (e.g. guardian question conversations, task run conversations), the conversation and initial message **MUST** be persisted before the conversation-created event is emitted. This ensures the macOS/iOS client can immediately fetch the conversation contents when it receives the event.

Guardian-request producers (access requests, tool approvals, tool-grant escalations, voice questions, trusted-contact confirmations) **MUST** record approval-card deliveries through `recordApprovalCardDelivery` / `recordGuardianRequestDeliveries` in `guardian-delivery-recorder.ts` -- never by calling the gateway client's `createGuardianRequestDelivery` directly. That sink is the single place the card-to-request addressing convention lives (conversation id for the in-app card; chat + channel-native `ts` for channel cards), so the path that writes a delivery row cannot drift from the paths that read it back to withdraw a card or resolve an emoji reaction -- the drift that previously fanned this logic into four divergent copies. (Tests may seed delivery rows directly for fixtures.)

Approval-card **source references** (the link back to the channel message that triggered a request) resolve only through `resolveApprovalSourceReference()` in `runtime/approval-source-link.ts` -- producers spread the result into the `guardian.question` context payload and never hand-build links. Channel-format knowledge (id shapes, permalinks, mrkdwn) lives only in `messaging/providers/<channel>/` and `notifications/adapters/<channel>`; the four-layer ownership map is documented at the top of `approval-source-link.ts`. Exception: access-request cards predate the registry and still derive their Slack permalink from payload `messageTs` in `access-request-copy.ts` -- converge them onto the registry rather than adding a third resolution path.

Guardian-request card rows are **not conversation history**. Only the vellum delivery persists a message row (`pairDeliveryWithConversation` pins it to the conversation the request is _about_, via `buildVellumCardAffinity`); channel guardian cards are delivery projections and pair no conversation at all, with the gateway delivery row (chat id + channel-native message id) as their only persisted envelope. `isGuardianCardRow` in `approval-card-data.ts` is the single definition of which rows are guardian cards (including rows channel deliveries paired before the projection-only policy), derived from the card's own `ui_surface` id rather than a stored marker so old rows need no backfill. **Both** history assemblers must consult it -- `Conversation.loadFromDb` and `loadSlackChronologicalContext`, which re-reads rows rather than using `this.messages` -- or the unfiltered one replays the card between a parked turn's `tool_use` and its `tool_result` and history repair destroys the real result. Surface state is exempt on purpose: the card's buttons must still route after a restart. Full rationale in [docs/guardian-request-flow.md](../../docs/guardian-request-flow.md).

## Notifications that want something from the reader

Three shapes, and picking the wrong one is what produces per-condition cards:

| Shape      | The reader                                                                                             | Carried by                                        |
| ---------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **Decide** | picks between named choices; the system is blocked until they do                                       | the guardian-request pipeline (`guardianRequest`) |
| **Repair** | asks for one known operation to be performed                                                           | `remediation` (below)                             |
| **Go**     | has to do something we cannot do for them (add credits, free disk, grant consent in someone else's UI) | `entityLinks` / `actions[]`                       |

They share a presentation on purpose: `feedItemAwaitsUserAction()` gives all of them the same callout, and their control sits in the same footer action group. Do not invent a fourth attention treatment for a new condition; work out which of the three it is first.

The boundary between **Repair** and **Go** is whether the client can complete it unattended. Re-provisioning a credential is a repair. Anything that needs a consent window, a payment, or a decision inside another product is a **Go**, even when a client could technically start it.

## Notifications that carry a fix

A notification reporting something broken **MUST** offer the repair as a `remediation` on its feed item, never as a card built for that one condition. `FeedRemediationSchema` (`api/responses/home.ts`) is the contract: the producer names a fix and authors its label, and renderers look the name up and render. Same ownership split as guardian card actions -- built once, centrally; renderers render -- extended to conditions that are not requests.

A remediation is work the **client** performs, with no turn and no model in the loop. That is what separates it from `actions[]`, which seeds a conversation. Use a remediation when the client can just fix the thing (re-provision a credential, restart a service, reconnect a transport); use an action when the right next step is asking the assistant.

The attach point is `deriveRemediation()` in `home-feed-side-effect.ts`, beside `deriveCategory` / `deriveDetailPanelKind`. Adding one is three edits and no new component:

1. a value on `FeedRemediationActionSchema`,
2. a branch in `deriveRemediation()`,
3. a handler in the client's remediation registry (`domains/home/detail-panel/feed-remediation-registry.ts` in the web client).

**Name the instance in `params` whenever the condition can occur more than once.** A workspace has one managed inference credential, so its repair needs none; OAuth connections and channels come in multiples, and a repair that cannot say which one it repairs cannot be offered at all. `telegram.webhook_health_alert` is the nearest un-served case and is parameterized this way.

Rules that keep this from decaying into per-condition cards:

- **Producers declare, renderers never infer.** `deriveRemediation()` reads a field the producer already publishes saying its condition is client-repairable (e.g. the credential health check's `clientRecoveryAction`). A renderer that pattern-matches payload fields to decide which button to draw is the thing this replaces.
- **An unknown action renders nothing.** Clients ship on their own cadence, so a remediation named by a newer daemon must degrade to the notification exactly as it reads today. Never throw, and never render a disabled button for a fix this build cannot perform.
- **The producer owns the label**, because it is the side that knows what the fix does. Renderers compose only the states the button itself has (running, done, failed).
- **A handler reports failure by throwing**, and its message is shown to the reader, so it names what the reader must resolve ("sign in to Vellum") rather than an internal cause.
- **An item carrying a remediation is awaiting the user.** `feedItemAwaitsUserAction()` covers both it and a pending guardian request, so both take the same callout. Do not add a second attention treatment.
- **Copy names the reader's experience, not the mechanism.** The producer authors both the label and the body, so internal vocabulary reaching a surface is a producer bug, not a rendering one. "Vellum AI is paused" is the condition; "the managed inference credential was rejected" is our word for its cause.
- **Say each thing once.** The panel header names the notification and the footer carries its time, so a card repeating either is noise. A card's meta line carries identity the header does not already give (the account a connection belongs to), and is omitted when there is none.
- **Withhold diagnostic status labels when a remediation is present.** Raw status vocabulary is actionable only when the reader picks the fix from it; once one button covers every status, the label is jargon at best and misattributed blame at worst (a credential the user never connected reading "Revoked").
