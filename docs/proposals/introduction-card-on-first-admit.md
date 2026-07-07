# Proposal: introduction card on first admit (notify-on-admit)

Implementation plan for option 2 of
[docs/investigations/contact-creation-admission-flow.md](../investigations/contact-creation-admission-flow.md)
(LUM-2728): when a not-yet-classified sender **clears the admission floor**, the
guardian still receives the introduction/trust-assignment card — informationally,
while the message proceeds. Admission stays governed by the floor; guardian
awareness and trust classification stop depending on a denial.

## Behavior specification

**Trigger.** The first time a non-guardian, non-trusted actor (trust class
`unverified_contact` or `unknown`) is admitted by the floor stage on an enforced
channel. In practice this only occurs with `channel-trust-floors` on and the
floor at `any_contact` or `strangers` — under stricter floors these actors are
denied and the existing deny-path card already fires.

**Effect.** The guardian receives the existing introduction card (same
signal-driven action set: Trust / Verify with a code / Leave unverified / Block).
Message processing is unaffected: the nudge is fire-and-forget and never blocks,
gates, or delays the turn. The sender receives nothing extra — they were
admitted and get the assistant's normal reply.

**Once-ever semantics.** The nudge fires at most once per
(assistant, channel, actor): it is suppressed when **any** prior
`access_request` exists for that actor in any state (pending, approved, denied,
expired). This is deliberately stricter than the deny-path card, which may
re-prompt after expiry — a denied sender still can't get in, so re-prompting has
value; an admitted sender loses nothing if the guardian ignores the card, so
re-prompting on every message is noise.

**Copy.** The card must not say "requesting access" — the sender is already in.
Framing: *"<name> reached you on <channel> and was admitted under your
'<floor label>' setting — decide how much to trust them."* This is the
admitted-mode variant only; the broader deny-path copy reframe stays in
LUM-2596.

**Decision semantics — unchanged.** All four outcomes already do the right
thing for an admitted requester
(`assistant/src/approvals/guardian-request-resolvers.ts:671-1240`):

- **Trust** → channel `active` (`trusted_contact`).
- **Verify with a code** → identity-bound handshake; `active` on redemption.
  Bots are coerced to Trust (a bot can't return a code).
- **Leave unverified** → stays `unverified`; the terminal denied record
  suppresses future prompts but does **not** retract admission — the floor
  keeps governing (existing documented semantics,
  `inbound-stages/acl-enforcement.ts:667-671`).
- **Block** → `revoked`; denied at every floor thereafter.

**Gating.** Behind the existing `channel-trust-floors` flag — the gap this
closes only exists when the flag is on, and reusing it avoids a new
feature-flag registry entry and platform Terraform companion PR.

## Non-goals

- No change to deny-path behavior, mention-gating, the gateway lazy seed, floor
  semantics, or capability resolution.
- Not option 1 (notify-on-creation at the gateway seed) and not option 3
  (re-ranking seeded contacts).
- Voice (`assistant/src/calls/call-setup-flow.ts`) fires its own access request
  pre-admission — out of scope.

## Implementation steps

### 1. Add a trigger mode to `notifyGuardianOfAccessRequest`

`assistant/src/runtime/access-request-helper.ts`:

- Extend `AccessRequestParams` with `trigger?: "denied" | "admitted"`
  (default `"denied"`, so all existing call sites are untouched).
- Persist the trigger on the canonical request so redeliveries and the
  conversational engine render the same framing. Preferred: a nullable
  `trigger` column on `canonical_guardian_requests`
  (`assistant/src/persistence/schema/guardian.ts`) with a DB migration
  (fresh numeric prefix, registered individually in
  `assistant/src/persistence/steps.ts`). Alternative without a migration:
  fold it into the `requesterSignals` JSON — rejected as a default because it
  conflates platform identity facts with request provenance, but acceptable if
  we want to avoid a migration in the first cut.
- For `trigger: "admitted"`: `attentionHints.urgency: "normal"` (deny-path
  stays `"high"`), `questionText` variant, and skip nothing else — the
  existing pending-dedup, terminal-denial suppression, and handshake-window
  suppression apply verbatim (`access-request-helper.ts:231-289`).
- Add a once-ever lookup, e.g. `hasAnyAccessRequestForActor({
  canonicalAssistantId, sourceChannel, actorExternalId })` — same
  assistant-scoped `conversationId` keying as the existing queries
  (`accessRequestConversationId`), `kind: "access_request"`, **no status
  filter**.

### 2. Hook the admitted branch in the inbound pipeline

`assistant/src/runtime/routes/inbound-message-handler.ts`, after the floor
stage admits (the `enforceAdmissionPolicy` call at `:775-783`), before agent
dispatch:

```ts
if (
  channelTrustFloorsEnabled &&
  admissionResult.admitted &&
  !isAdmissionPolicyExemptChannel(sourceChannel) &&
  !isCallbackInteraction &&
  (trustClass === "unverified_contact" || trustClass === "unknown")
) {
  void nudgeGuardianForNewlyAdmittedContact({ ... }).catch(...);
}
```

- Fully fire-and-forget; the once-ever lookup runs inside the async helper so
  the hot path pays nothing.
- Exempt channels must be excluded explicitly: the floor stage short-circuits
  them to `admitted: true` (`inbound-stages/admission-policy.ts:120-122`), and
  `a2a`/`platform` are outside the human-trust model.
- Blocked/revoked actors never reach here (floor stage denies them,
  `admission-policy.ts:131-139`).
- Guardian and `trusted_contact` are excluded by the trust-class check —
  this also prevents the LUM-2586 class of guardian self-trigger false
  positives.

### 3. Card copy and rendering

- `assistant/src/notifications/access-request-copy.ts` +
  `approval-card-builder.ts` / `approval-card-data.ts`: branch on the persisted
  trigger to render the admitted framing (header, body, no "requesting
  access" language). Button set unchanged — `buildIntroductionActions`
  (`assistant/src/runtime/introduction-policy.ts:264`) is already
  signal-driven and correct for both modes.
- `assistant/src/notifications/adapters/slack.ts`: no structural change.
- Delivery routing (`sameChannelOnly`, vellum fallback) unchanged.
- Dependency note: LUM-2594 (card not delivered to the Vellum conversation
  list) degrades this card exactly as it degrades deny-path cards — fixing it
  alongside materially improves this feature but is not a blocker.

### 4. Resolvers — no changes

`guardian-request-resolvers.ts` outcomes are already correct (see Behavior).
Two things to verify with tests rather than change:

- Trust / Leave unverified must handle an actor with **no contact record yet**
  (a `strangers`-floor admit on a channel without the Slack lazy seed):
  `activateMemberChannel` / `seedUnverifiedMemberChannel` already create the
  contact + channel — pin with a test.
- `verify_code` DMs the requester a code — acceptable for an admitted human
  when the guardian explicitly picks it.

### 5. Interaction cases the tests must pin

| Case | Expected |
| --- | --- |
| First-message race: seed uncommitted → `unknown` → denied under `any_contact` → deny card; second message admits | Once-ever guard sees the existing request → no duplicate nudge |
| Repeated messages while the nudge card is pending | Helper pending-dedup returns the existing request; no re-notify |
| Guardian previously chose Leave unverified (terminal denied record) | Suppressed — no nudge, admission continues per floor |
| `strangers` floor, non-Slack channel, actor with no contact record | Nudge fires; Trust/Leave-unverified create the record |
| Exempt channels (`a2a`, `platform`), callbacks, flag off, guardian, trusted contact | No nudge |
| Card expires undecided; sender messages again | No re-nudge (once-ever) |

### 6. Tests

- `inbound-message-handler` tests: the full matrix in §5.
- `access-request-helper` tests: trigger persisted, urgency `normal`,
  questionText variant, once-ever query semantics.
- Card copy tests for the admitted variant (both card-data and Slack Block Kit
  assembly).
- DB migration test following `assistant/src/__tests__/db-*.test.ts` patterns
  (if the column route is taken).

### 7. Rollout

Ships dark behind `channel-trust-floors` (defaultEnabled false). Dogfood on an
instance with the floor at `any_contact`: expected result is that a lazily
created contact (e.g. a peer assistant bot messaging in Slack) now yields one
introduction card while its messages continue to flow. Update the
investigation doc's §5 status and add a note to the `any_contact` row of the
floor table in `gateway/CLAUDE.md` ("admitted unverified senders trigger a
one-time introduction card").

## Open questions for review

1. **Cross-channel scope of once-ever** — recommended per-channel (matches the
   existing assistant+channel+actor `conversationId` keying); a cross-channel
   guard would need a new query shape.
2. **Attention hints** — recommended `requiresAction: true` (a classification
   decision is genuinely wanted) with `urgency: "normal"`; if push volume is a
   concern, drop to `requiresAction: false` for the admitted mode.
3. **Include `unknown`-class admits** (`strangers` floor) or only
   `unverified_contact`? Recommended: both — guardian awareness is the point,
   and `strangers` is the floor with the least other signal.
