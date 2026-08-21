# Guardian requests: the interactive-request pipeline

This is the end-to-end map of how an interactive request — anything the
assistant needs a person to decide or answer — reaches a user on any channel
and how their response resolves it. **It is the canonical rail for interactive
channel features.** If you are adding a feature that shows buttons/options on
a channel and waits for a reply, extend the seams below; do **not** build a
per-feature watcher, callback scheme, or parallel delivery stack (that
anti-pattern was retired in #35642 and again in the ask_question redesign).

## The lifecycle

```
  tool / flow parks a pending interaction        (runtime/pending-interactions.ts)
        │
        ▼ promotion (fire-and-forget, at the emitter)
  guardian_requests row, gateway-owned           (permissions/confirmation-guardian-request.ts,
  create → decide(CAS) → expire/sweep             permissions/question-guardian-request.ts,
        │                                         gateway/src/db/guardian-request-store.ts)
        ▼ bridge emits guardian.question signal
  notification pipeline                          (notifications/emit-signal.ts →
  decision engine → destination resolver →        decision-engine.ts → destination-resolver.ts →
  broadcaster builds the card context ONCE        broadcaster.ts: resolveApprovalContext /
  (generic actions[] + plainTextFallback)         resolveQuestionOptionsContext)
        │
        ▼ per-channel rendering ONLY
  channel adapters                               (notifications/adapters/{telegram,slack,macos,platform},
  telegram: inline keyboard; slack: blocks;       vellum: conversation card via approval-card-builder)
  card deliveries recorded per channel            (guardian-delivery-recorder.ts → guardian_request_deliveries)
        │
        ▼ user responds: button tap / emoji reaction / "CODE <reply>" / bare text
  guardian reply router                          (runtime/guardian-reply-router.ts, invoked from
  reactions → callbacks → request codes →         routes/inbound-stages/guardian-reply-intercept.ts,
  bare answer → explicit approve/reject → NL      BEFORE background dispatch — replies to parked
        │                                         prompts resolve inline, never deferred)
        ▼ one decision primitive
  applyGuardianDecision                          (approvals/guardian-decision-primitive.ts:
  status CAS + ACL outcome, atomic;               first-writer-wins; card withdrawal on decide)
        │
        ▼ per-kind follow-through
  resolver registry                              (approvals/guardian-request-resolvers.ts)
  tool_approval → confirmation resume             pending_question → voice answerCall OR
  access_request → ACL outcome                    ask_question interaction resolve
```

## Who owns what

| Concern                                 | Owner                                                    | Never                               |
| --------------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| The "what": card text, actions, options | broadcaster context build (once per broadcast)           | built per-adapter                   |
| The "how": channel-native rendering     | `notifications/adapters/<channel>`                       | domain logic, payload parsing       |
| Request state                           | gateway `guardian_requests` (+ deliveries)               | daemon-side request tables          |
| Decisions                               | `applyGuardianDecision` (CAS, atomic ACL outcome)        | inline decision logic at call sites |
| Kind-specific follow-through            | resolver registry (`kind` → resolver)                    | switch statements in the router     |
| Reply understanding                     | guardian reply router (codes, buttons, reactions, modes) | per-feature inbound intercepts      |

## Cards are not conversation history

`pairDeliveryWithConversation` persists one message row per delivery so the
card renders and deep-links. For a guardian card that row is addressed to a
conversation the request is _about_, not one the assistant is speaking in:
`buildVellumCardAffinity` pins the vellum card to the originating
conversation, and a channel card lands in whatever conversation the guardian's
chat binds to. Either way the row is written straight to the DB by the
notification pipeline, so the live turn's in-memory history never sees it.

That row must never be replayed to the model. The conversation it lands in is
typically parked mid-approval, with its last assistant message carrying the
`tool_use` still waiting on this very decision. Replayed, the card sits
between that `tool_use` and its `tool_result`; history repair reads the pair
as broken, synthesizes a stub result, and downgrades the real one to text. A
card left as the tail row instead ends the history on an assistant message,
which extended-thinking models reject outright ("does not support assistant
message prefill").

`isGuardianCardRow` (`notifications/approval-card-data.ts`) is the one
definition of which rows those are, read off the card's own `ui_surface` id
using the same prefixes `approvalCardSurfaceId` recomputes for withdrawal. It
is derived rather than stored so a row written before the rule existed is
recognized on the same terms as a new one, with no marker to backfill.

**Both history assemblers must consult it.** `Conversation.loadFromDb` builds
`this.messages`, but Slack conversations do not use that list:
`loadSlackChronologicalContext` re-reads the rows. A rule applied to only one
exempts the other channel. Each applies it _after_ its own compaction boundary,
since both boundaries are computed against unfiltered row lists.

Surface state is deliberately NOT filtered this way. `restoreSurfaceStateFromHistory`
takes the pre-filter window, because a card's Approve/Reject buttons must keep
routing after a restart even though the card is absent from the model's history.

Two instruction modes exist per request kind (`notifications/guardian-question-mode.ts`):
**approval** ("CODE approve" / approve–reject buttons) and **answer**
("CODE <your answer>" / option buttons). `pending_question` is answer-mode.

## Worked example: `ask_question` on a channel

1. The tool parks on `QuestionPrompter` when the turn can deliver a card
   (`ToolContext.supportsGuardianQuestionCards` — single-question batch,
   guardian turn, channel in `GUARDIAN_QUESTION_CARD_CHANNELS`); otherwise it
   returns the plain-text fallback.
2. The prompter promotes the interaction to a `pending_question` row
   (`permissions/question-guardian-request.ts` — request id = interaction
   requestId, mirroring `tool_approval`) and bridges it
   (`runtime/question-request-guardian-bridge.ts`).
3. The broadcaster renders the options as card actions with answer-token ids
   (`answer_<idx>` / `answer_skip` — `buildQuestionOptionActionId`); adapters
   need no changes, ever.
4. A tap arrives as `apr:<requestId>:answer_<idx>`; the router recognizes the
   token for answer-mode requests. A bare text reply while exactly one
   answer-mode request is pending IS the answer. "CODE <text>" works like any
   request.
5. The `pending_question` resolver (no `callSessionId` → ask_question branch)
   maps the token/text to a submission and settles the interaction via
   `resolvePendingQuestion` — the same core `/v1/question-response` uses — so
   the parked tool returns and the turn continues.
6. Lifecycle: answered elsewhere / timed out → the orphan sweep in
   `conversation-routes.ts` expires the row (voice rows, which carry
   `callSessionId`, are exempt); daemon restart → boot's
   `expire_interaction_bound`.

## Adding a new interactive request kind

1. Add the kind to `GuardianRequestKindSchema`
   (`packages/gateway-client/src/guardian-request-contract.ts`).
2. Promote at the emitter (mirror `confirmation-guardian-request.ts`) and
   bridge to `emitNotificationSignal` with a typed payload
   (`guardian-question-mode.ts` schemas).
3. If the card needs non-default actions, add a context branch in the
   broadcaster — actions are generic `{id,label}`; adapters are untouched.
4. Add reply-mode config (`REQUEST_KIND_MODE_CONFIG`) if the kind answers
   rather than approves.
5. Register a resolver (`guardian-request-resolvers.ts`) for the kind's
   follow-through.

That is the whole checklist. If a design requires touching the inbound
message handler, a channel transport, or a new callback prefix, the design is
at the wrong level.

## Legacy rail (in-turn approval interception)

`routes/guardian-approval-interception.ts` + the approval prompt watcher in
`background-dispatch.ts` predate this pipeline: they deliver a guardian's own
tool-approval prompt mid-turn and resolve `apr:` taps against the in-memory
confirmation directly. That prompt is addressed to the guardian, not to the
chat the turn is running in. On Slack that chat can be a shared room, and the
card carries the tool, a command preview and live buttons.
`resolveGuardianPromptDelivery` addresses it to the guardian's bound DM
instead, by chat id rather than user id because that address is written to the
delivery row and read back to match reactions, scope plain-text replies and
edit the decided card. It returns the address and its route together, since
the turn's own callback carries a `threadTs` naming a thread that does not
exist in the DM. When no private address resolves it returns nothing and the
prompt is left to the in-app confirmation, because the room is the disclosure
this exists to prevent. Telegram group chats carry the same exposure and are
not covered: only Slack has a chat whose privacy can be read off its id. They remain load-bearing for that flow, and
the reply router runs first for everything the pipeline owns. Converge new
work on the pipeline; do not extend the legacy interception.
