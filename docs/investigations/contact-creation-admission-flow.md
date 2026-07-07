# Investigation: contact creation + admission approval flow

Maps every path that creates a contact record, every path that fires (or fails to
fire) the guardian introduction/access-request card, and the gaps between current
and intended behavior. Feeds the design decision on whether lazy contact creation
should always surface a trust-assignment nudge, independent of the admission
floor. Tracked in Linear as LUM-2728.

## 1. The underlying model: three orthogonal dimensions

The system tracks three separate facts about a sender, in three separate places.
Understanding where each lives explains every observed behavior.

| Dimension | Storage | Written by |
| --- | --- | --- |
| **(a) Contact record exists** | Gateway DB `contacts` + `contact_channels` rows (ACL source of truth: `gateway/src/db/contact-store.ts`), mirrored best-effort to the assistant DB (identity/notes only: `assistant/src/contacts/contact-store.ts`) | Creation paths in §2 |
| **(b) Verified** | `contact_channels.status` (`active \| pending \| unverified \| revoked \| blocked`, `assistant/src/contacts/types.ts:42`) plus `verifiedAt`/`verifiedVia`. There is **no separate stored trust level** — "verified" and "trusted" are the same bit (`status = "active"`) | `markChannelVerified` / `markChannelRevoked` (`gateway/src/db/contact-store.ts:713-823`), intro-card resolvers |
| **(c) Admitted** | Per-**channel-type** `AdmissionPolicy` floor, gateway table `channel_admission_policy` (`gateway/src/db/admission-policy-store.ts`), stamped onto each inbound as `sourceMetadata.admissionPolicy` | Settings UI (flag-gated), seed defaults (`gateway/src/db/seed-admission-policy.ts`) |

Trust is **derived, never stored**: the gateway classifier
(`gateway/src/risk/trust-verdict-resolver.ts:188-205`) maps channel status to a
`TrustClass` — `guardian` (rank 4), `trusted_contact` (rank 3, `status="active"`),
`unverified_contact` (rank 2, `pending`/`unverified`), `unknown` (rank 1, no row
or blocked/revoked). Admission is `TRUST_CLASS_RANK[trustClass] >=
ADMISSION_FLOOR[policy]`
(`assistant/src/runtime/routes/inbound-stages/admission-policy.ts:143-148`).

The floors (`packages/gateway-client/src/admission-policy-contract.ts:18-48`),
with their web UI labels:

| Policy | Floor | UI label | Admits |
| --- | --- | --- | --- |
| `no_one` | 5 | No one | nobody (gateway kill switch, `gateway/src/handlers/handle-inbound.ts:99-114`) |
| `guardian_only` | 4 | Only you | guardian |
| `trusted_contacts` | 3 | Verified contacts | guardian + verified (seed default for all channels except `vellum`) |
| `any_contact` | 2 | Any contact | + unverified contacts (any contact **record**) |
| `strangers` | 1 | Strangers | everyone except blocked/revoked |

Two structural conflations fall out of this model:

- `TrustClass` collapses (a) and (b) into one axis: creating a contact record
  moves a sender from rank 1 to rank 2, so **creation alone changes the
  admission outcome** at the `any_contact` floor.
- Capabilities do **not** distinguish verified from unverified
  (`trusted_contact ≡ unverified_contact` share one `CapabilitySet`,
  `assistant/src/runtime/capabilities.ts`; pinned by `capabilities.test.ts`).
  The verified bit is admission-only. So under permissive floors, verification
  changes nothing at all downstream.

## 2. All paths that trigger contact creation

### 2.1 Lazy inbound seed (the path that fired in the live test)

`gateway/src/index.ts:2213-2237` — inside the Slack `forward()` closure, run for
**every Slack event that passes the socket-mode filter**, before trust
resolution:

```ts
void upsertContactChannel({
  sourceChannel: "slack",
  externalUserId: normalized.event.actor.actorExternalId, // the SENDER
  ...(chatType === "im" ? { externalChatId: conversationExternalId } : {}),
  displayName: ..., username: ...,
  ...(normalized.botSender
    ? { contactType: "assistant", notes: slackBotContactNote(...) } : {}),
}).catch(() => {});
```

Properties of this seed:

- **Unconditional.** Fire-and-forget, not gated by `channel-trust-floors`, not
  gated by the floor value, runs before `handleInbound`/`resolveTrustVerdict`.
- **Sender-keyed.** Seeds `actorExternalId` only — a mentioned party is never
  extracted (see §2.8).
- **Defaults** (`gateway/src/verification/contact-helpers.ts:788-918`, insert
  defaults also at `gateway/src/db/contact-store.ts:1530-1531`): `role:
  "contact"`, channel `status: "unverified"`, `policy: "allow"`, `verifiedAt:
  null`, `isPrimary: false` ⇒ classifies as `unverified_contact` (rank 2).
- **Data pulled at creation:** display name from the resolved Slack profile
  (fallback username → address), DM channel ID linked for IMs, bot detection via
  `event.bot_id` or `users.info.is_bot`
  (`gateway/src/slack/normalize.ts:568-599`) ⇒ `contactType: "assistant"` with a
  provenance note. This matches the observed lazily-created record exactly.
- **Silent.** Writes DB rows only; emits no notification, no event, no card.
- **Slack-only.** This is the sole production caller of `upsertContactChannel`.
  Other channels have no equivalent inbound seed, which makes `any_contact`
  behave differently per channel (§4.2).

### 2.2 Verification / challenge / invite redemption

`upsertVerifiedContactChannel` (`gateway/src/verification/contact-helpers.ts:475`,
create branch `:664-763`) — creates or upgrades a contact when a sender passes a
code challenge or redeems an invite. Lands `status: "active"`, `verifiedAt: now`
⇒ `trusted_contact`.

### 2.3 Guardian bootstrap

`createGuardianBinding` (`gateway/src/auth/guardian-bootstrap.ts:292`) and the
contact-prompt submit path (`gateway/src/http/routes/contact-prompt.ts:156`) —
the only paths that mint `role: "guardian"`.

### 2.4 Control-plane upsert (explicit user action)

`ContactStore.upsertContact` (`gateway/src/db/contact-store.ts:1122`) via the
`create_contact` IPC method (`gateway/src/ipc/contact-handlers.ts:141`, forces
`role: "contact"`) and `POST /v1/contacts`
(`gateway/src/http/routes/contacts-control-plane-proxy.ts` ~`:1077`) — the web
"add contact" and account-linking picker.

### 2.5 Introduction-card resolvers (guardian decision side effects)

All in `assistant/src/contacts/member-write-relay.ts`, called from
`assistant/src/approvals/guardian-request-resolvers.ts`:

- `activateMemberChannel` (`:58`; callers `guardian-request-resolvers.ts:850,917`)
  — guardian chose **Trust** ⇒ `status: "active"`.
- `seedUnverifiedMemberChannel` (`:235`; caller `:756`) — guardian chose **Leave
  unverified** ⇒ contact exists at `status: "unverified"`, plus a terminal
  `denied` canonical request so the card won't re-fire.
- `blockSenderChannel` (`:165`) — guardian chose **Block** ⇒ `status: "revoked"`.

### 2.6 A2A invites

`assistant/src/daemon/handlers/config-a2a.ts:151,209,271` — placeholder and
redeemed peer-assistant contacts (`contactType: "assistant"`, `a2a` channel).
`a2a` is an admission-exempt channel (out of the human-trust model).

### 2.7 Paths that do NOT create contacts

- **No eager hydration.** `GET /v1/slack/users`
  (`assistant/src/runtime/routes/integrations/slack/users.ts`) is a read-only
  roster feeding the account-linking picker; nothing walks a roster or channel
  membership to pre-create contacts. There is no dead eager path either — the
  design is deliberately lazy.
- **No LLM tool.** Nothing in `assistant/src/tools/` creates contacts or sets
  trust; the assistant DB mirror upserts (`contacts_mirror_*` IPC) are
  gateway-driven only.
- **No CLI creation** (`assistant/src/cli/commands/contacts.ts` lists/prompts
  only).

### 2.8 Why a message creates a contact but a mention doesn't

Two independent mechanisms compose:

1. **The socket-mode filter decides whether `forward()` runs at all**
   (`gateway/src/slack/socket-mode.ts:961-995`). Public/group-channel events are
   forwarded only when the *receiving* bot is @-mentioned, the message is a
   tracked-thread reply (`mention_then_thread` mode, `:925-932`), or a scoped
   reaction/edit. DMs always forward (`:919-923`). Everything else is dropped
   before normalization — no seed, no trust check, nothing.
2. **The seed keys on the sender, never the mentioned party**
   (`gateway/src/index.ts:2218-2221`). Mentioning a peer bot puts `<@bot>` in the
   message *body*; the mentioned bot is never extracted as a contact. A peer
   assistant becomes a contact only when it is itself the **sender** of a
   forwarded message (its own @mention of the receiving bot, a DM, or a tracked
   thread reply) — at which point `botSender` is set and it seeds as
   `contactType: "assistant"`. The receiving bot's own messages are self-filtered
   (`socket-mode.ts:848-860`); a peer bot has a different user ID and passes.

So "mention → no contact, message → contact" is by construction, not a bug —
but it does mean the guardian never sees a peer assistant in the contact book
until that assistant speaks.

## 3. All paths where the introduction/access-request card fires (or doesn't)

### 3.1 The card and what it does

Single generator: `notifyGuardianOfAccessRequest`
(`assistant/src/runtime/access-request-helper.ts:172-413`) — creates a canonical
`access_request` and emits an `ingress.access_request` notification, delivered
via the notification pipeline (card assembly in
`assistant/src/notifications/approval-card-builder.ts`,
`access-request-copy.ts`; Slack Block Kit in `notifications/adapters/slack.ts`).

The card **is** the trust-assignment step. Its action list is signal-driven
(`buildIntroductionActions`, `assistant/src/runtime/introduction-policy.ts:264-284`):

- workspace-vouched / bot / voice: `[ Trust ] [ Leave unverified ] [ Block ]`
- external / stranger / guest: `[ Verify with a code ] [ Trust anyway ] [ Leave unverified ] [ Block ]`

Resolution (`accessRequestResolver`,
`assistant/src/approvals/guardian-request-resolvers.ts:671-1240`): `trust` ⇒
`status="active"` (`trusted_contact`); `verify_code` ⇒ identity-bound code
handshake, active on redemption (bots are coerced to `trust`, `:720-730`);
`leave_unverified` ⇒ `status="unverified"` + terminal denial (suppresses
re-prompt, not admission); `block` ⇒ `status="revoked"`. There is **no other
trust-assignment UX**: the web contact page offers only Verify/Revoke per channel
(`clients/web/src/domains/contacts/components/contact-channels-section.tsx:353-399`),
and there is no post-approval "set trust level" nudge — `trusted_contact` is the
ceiling.

### 3.2 Every call site — all on deny paths

| Call site | Lane |
| --- | --- |
| `assistant/src/runtime/routes/inbound-stages/acl-enforcement.ts:420,503,554` | ACL deny: sender has **no contact record** (`not_a_member`); Slack non-bot variant also DMs a self-verify code challenge |
| `acl-enforcement.ts:730,809` | ACL deny: sender has a contact record that is **not active** (`pending`/`unverified`/`revoked`; blocked is excluded — guardian already decided) |
| `assistant/src/runtime/routes/inbound-message-handler.ts:834` | Admission-floor deny branch (only reachable with `channel-trust-floors` on) |
| `assistant/src/calls/call-setup-flow.ts:1384` | Voice-call setup from an unrecognized caller |

Suppression inside the generator (`access-request-helper.ts:231-289`): terminal
denial for the same sender, an in-flight approval handshake, callback
interactions (LUM-2673), duplicates.

**There is no call site on an admit path, and no floor-independent "new contact
created" notification anywhere.** The seed (§2.1) writes rows silently.

### 3.3 Behavior matrix: floor × sender class

Everything below assumes an enforced channel (Slack). Trust class is resolved
*after* the seed, so a first-time Slack sender is effectively always
`unverified_contact` (rank 2), not `unknown` (rank 1) — see §4.2.

**With `channel-trust-floors` OFF (the shipped default —
`meta/feature-flags/feature-flag-registry.json:381-388`):** the floor stage is
skipped entirely and the ACL takes none of its policy-aware bypasses
(`inbound-message-handler.ts:449-464,775-783`). Every non-guardian sender whose
channel is not `active` is denied by the ACL: unverified/pending members hit the
inactive-member lane, no-record senders hit the non-member lane. Both lanes fire
the card (and, on Slack for non-bots, the self-verify DM challenge). **Flag off
= the guardian is always prompted for anyone unverified.**

**With `channel-trust-floors` ON, per floor:**

| Floor | Guardian (4) | Verified contact (3) | Unverified contact (2) — incl. every lazily-seeded sender | Stranger, no record (1) |
| --- | --- | --- | --- | --- |
| `no_one` | dropped at gateway, no card | same | same | same |
| `guardian_only` | admit | deny, **card fires** (silent deny, no challenge — `shouldChallenge: false`) | deny, **card fires** (ACL bypass at `acl-enforcement.ts:676-679` routes to floor stage; card at `inbound-message-handler.ts:834`) | deny, **card fires** (bypass at `:370-376`) |
| `trusted_contacts` (default) | admit | admit, no card | deny at ACL, challenge + **card fires** (not bypassed — verification legitimately clears floor 3) | deny at ACL, challenge + **card fires** |
| `any_contact` | admit | admit, no card | **ADMIT SILENTLY — NO CARD** (ACL bypass for `pending`/`unverified` at `:676-679`; floor admits rank 2 ≥ 2) | deny, challenge + card — but on Slack this state barely exists (§4.2) |
| `strangers` | admit | admit, no card | admit, no card | admit, no card |

Blocked/revoked senders are denied at every floor with no card
(`admission-policy.ts:131-139`, `acl-enforcement.ts` blocked exclusions) —
guardian already decided.

Denied messages are recorded, marked processed, answered with a canned
(Slack-ephemeral) reply, and **never dispatched to the agent loop**
(`inbound-message-handler.ts:784-911`). They are not queued for later replay.

## 4. Gaps: current vs intended behavior

### 4.1 The headline gap: trust assignment is coupled to admission denial

The introduction card — the *only* moment the guardian assigns trust — fires
exclusively on deny. Contact creation itself is silent. So at any floor
permissive enough to admit the sender (`any_contact` admits every lazily-seeded
sender; `strangers` admits everyone), a new contact enters the contact book and
starts conversing with **zero guardian touchpoint**: no card, no notification,
no trust-assignment nudge. This is exactly the observed live-test behavior and
the design tension named in LUM-2728: intended behavior (per the ticket) is that
lazy creation should *always* give the guardian a trust-assignment moment; the
floor should govern admission, not guardian awareness.

Mitigating context: capabilities for unverified and trusted contacts are
identical and heavily restricted (no memory recall, no privileged tools, no
guardian context — `assistant/src/runtime/capabilities.ts` and the invariants in
`assistant/src/approvals/AGENTS.md`), so the exposure is conversational access,
not privilege. The gap is guardian *awareness and classification*, not a
privilege escalation.

### 4.2 The lazy seed quietly rewrites `any_contact` semantics on Slack

Because the seed (§2.1) runs before classification and promotes every
first-time Slack sender from rank 1 to rank 2, the `any_contact` floor (rank ≥ 2)
is cleared by **anyone whose message gets forwarded**. The rank-1 "stranger"
state — the only class `any_contact` excludes — is essentially unreachable on
Slack (only a race between the fire-and-forget seed and verdict resolution on
the very first message, and blocked/revoked actors). Effect: **on Slack,
`any_contact` ≈ `strangers`**, and the deny-path card + upgrade challenge that
`any_contact` is documented to surface (`gateway/CLAUDE.md` floor table) almost
never fire. On channels without an inbound seed (everything except Slack),
`any_contact` still means what it says. Same floor value, different effective
policy per channel — an undocumented asymmetry.

### 4.3 Verified/trust are one collapsed axis; creation mutates admission

The three dimensions — record exists, verified, admitted — are stored
separately (§1) but read through one derived `TrustClass`, so dimension (a)
leaks into dimension (c): *creating a record* is indistinguishable, for
admission purposes, from *the guardian leaving someone unverified on purpose*.
A guardian-reviewed "leave unverified" contact and a never-reviewed auto-seeded
contact are the same rank 2. If the intent of `any_contact` is "anyone I've at
least seen and classified", the model needs a fourth state (e.g. seeded-but-
unreviewed vs guardian-acknowledged), or creation must always trigger review
(§5).

### 4.4 Flag-state split brain

The floor picker UI, floor enforcement, and the floor-deny card are all gated on
`channel-trust-floors` (default off; enforcement kill switch in
`gateway/src/risk/admission-policy-cache.ts:84-99`), but the contact seed is
not. Flag off is actually the *stricter* regime (every unverified sender denied
+ card); turning the flag on and selecting a permissive floor silently disables
the card for all lazily-created contacts. A user enabling "Any contact" to be
*more* reachable unknowingly also opts out of new-contact review — the two
concerns (reachability, review) have no independent controls.

### 4.5 Mention produces no record (by design, worth documenting)

§2.8: a mentioned peer assistant is never contact-seeded; it appears only when
it speaks. Not a bug, but it surprised the live test and belongs in the intended-
behavior documentation for the design ticket.

### 4.6 Known related defects (prior art)

- LUM-2594 — access-request card renders in Slack but not in the Vellum
  conversation list (guardian can't decide from the app).
- LUM-2595 — card CTA should deep-link to the already-lazily-created contact
  record.
- LUM-2596 — "Access Request" copy misframes what is really a
  contact-classification decision.

All three assume the card fires; the gap in this investigation is the class of
cases where it never fires at all.

## 5. Design options for the follow-up ticket

The decision to make: **should lazy contact creation always surface a
trust-assignment nudge, independent of the admission floor?** Options, with the
code seams they'd touch:

1. **Notify on creation (decouple review from admission).** Emit a
   guardian-facing introduction card (or lower-friction inbox item) from the
   lazy-creation path regardless of floor, while admission proceeds per the
   floor. Seam: the seed is gateway-side and silent by design; the cleanest hook
   is runtime-side — on first admit of a sender whose channel is `unverified`
   and who has no prior canonical request, call the existing
   `notifyGuardianOfAccessRequest` machinery in *informational* mode (its dedup
   + terminal-denial suppression already prevents re-fires). Fits the LUM-2596
   reframing ("someone new reached your assistant — classify them"), and the
   card's four outcomes already are the trust-assignment UX.
2. **Notify-on-admit variant.** Same as (1) but keyed on floor-clearing rather
   than record creation, so mention-drops and never-admitted senders don't nudge.
   Practical difference from (1) is small on Slack (seed ⇒ admit under
   permissive floors) but avoids nudging for senders the floor denies (they
   already get the deny-path card).
3. **Re-rank auto-seeded contacts.** Introduce a distinction between
   seeded-but-unreviewed (rank 1 for admission) and guardian-acknowledged
   unverified (rank 2). Restores `any_contact`'s literal semantics and makes the
   existing deny-path card fire for auto-seeded senders — but changes admission
   behavior for all existing unverified contacts and adds a fourth persisted
   state (`TrustClass` and both enforcement sides must move together —
   `gateway/CLAUDE.md` reciprocity rule).
4. **Status quo + documentation** — rely on flag-off strictness and the default
   `trusted_contacts` floor, document that permissive floors trade away review.
   Rejected by the ticket's framing, listed for completeness.

Option 1 (or 2) is the smallest change consistent with "the floor governs
admission; creation always gets a classification moment", and it composes with
the LUM-2594/2595/2596 fixes rather than replacing them.
