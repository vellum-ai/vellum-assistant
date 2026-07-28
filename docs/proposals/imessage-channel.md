# iMessage as a Channel

> **Status:** proposal. Nothing below is implemented yet. This document maps the
> existing channel machinery, states what the two reference repos actually
> contain, and lays out a file-by-file plan.

## 0. Two findings that shape everything else

**`vellum-ai/imessage` is empty.** One commit ("Initial commit"), one file
(`README.md`, contents: `# imessage`). There is no prior art in it to copy or
extend, so the repo is a naming placeholder. Everything about its shape is still
open.

**The meeting-bot "channels pattern" is not a messaging-channel abstraction.**
`meeting-bot/channels/` contains exactly one file:

```json
{
  "routes": [
    {
      "path": "realtime",
      "kind": "websocket",
      "description": "Realtime event stream the meeting provider dials into (transcript, participant, and lifecycle events)."
    }
  ]
}
```

That is a **public ingress manifest**. It is consumed by
`gateway/src/channels/plugin-ingress.ts`, which scans
`<workspaceDir>/plugins/*/channels/ingress.json`, validates each declaration,
and exposes the approved routes at `/webhooks/plugins/<plugin>/<path>`.
`plugin-ingress-approvals.ts` gates that behind a guardian decision keyed on a
digest of `(kind, path)` pairs, so editing the manifest revokes the grant until
re-approved.

What that pattern gives a plugin: **a public URL, and only a public URL.** It
does not give the plugin a channel identity, a trust class, an admission floor,
a contact-channel row, or an outbound delivery path. `meeting-bot` does not need
any of those, because Recall.ai dials *in* to stream transcripts; nobody is
having a conversation with the assistant over it.

iMessage does need all of those. So the plan below uses the meeting-bot manifest
pattern for the transport hop, and adds `imessage` to the core channel
vocabulary for everything else. Both halves are required; neither is sufficient
alone.

## 1. How a channel works today

Two independent paths, worth keeping straight because they have different
registries and different failure modes.

### 1.1 Inbound

```
provider (socket or webhook)
  → gateway/src/<provider>/message-schemas.ts   tolerant zod parse
  → gateway/src/<provider>/normalize.ts          → GatewayInboundEvent
  → gateway/src/handlers/handle-inbound.ts       no_one kill switch, trust classification
  → runtime inbound stages                       admission floor, capabilities
  → conversation
```

`GatewayInboundEvent` (`gateway/src/channels/inbound-event.ts`) is a union
discriminated on `sourceChannel`, with the identity split the gateway
`CLAUDE.md` is emphatic about:

- `conversationExternalId` — delivery address (the iMessage chat GUID)
- `actorExternalId` — sender identity (the handle: phone number or Apple ID)

Trust decisions key on `actorExternalId` only. For iMessage this distinction is
load-bearing in a way it is not for Telegram: in a group chat the chat GUID is
shared by every participant, and Apple's `chat.db` will happily hand you a
message whose `handle_id` is a different person than the chat's own identifier.

### 1.2 Outbound

```
runtime renders reply
  → gateway callback URL  /deliver/<channel>
  → assistant/src/messaging/providers/callback-routing.ts   URL → DirectDeliveryChannel
  → assistant/src/messaging/providers/index.ts              channel → ChannelTransport
  → transport.deliver(ctx, payload)
```

`DIRECT_DELIVERY_CHANNELS` and the `TRANSPORTS` record are cross-checked by the
type system: `TRANSPORTS` is a `Record<DirectDeliveryChannel, ChannelTransport>`,
so adding a channel to one and not the other fails to compile. Optional methods
on `ChannelTransport` (`sendTyping`, `sendReaction`, `setThreadStatus`,
`streamReply`) are dispatched only when the payload carries the matching field.

### 1.3 Discord is the precedent to copy

Discord is the most recently added channel and the closest structural match,
because it is **not** a public webhook. The gateway dials an outbound socket and
holds it open (`gateway/src/index.ts:2424-2492`):

- gated purely on a credential (`discord_channel:bot_token`) — no feature flag
- kept out of `BASE_AVAILABLE_CHANNELS`
  (`assistant/src/runtime/routes/channel-availability-routes.ts:34`), so the
  channel only surfaces when configured
- restarted on `changed.has("discord_channel")` (`index.ts:2543`)
- stopped in shutdown (`index.ts:2811`)

An iMessage bridge has exactly this shape: a long-lived connection to something
that is not reachable at a stable public address, credential-gated, invisible
until set up. Copy Discord's lifecycle, not Telegram's webhook.

Discord is also currently listed in `ADMISSION_POLICY_HIDDEN_CHANNELS`
(`packages/gateway-client/src/admission-policy-contract.ts:83-91`) with the note
that it "has no ingress implementation, so there is nothing for a floor to
[gate]". Note that hidden is **not** exempt: hidden channels still enforce their
admission floor at runtime, they are just not user-configurable. iMessage should
start hidden and graduate to visible when the ingress lands.

## 2. Transport: how do we actually reach iMessage

Apple publishes no API. Every option is a bridge running on Apple hardware.
Three real candidates:

| Option | Shape | Pros | Cons |
| --- | --- | --- | --- |
| **A. BlueBubbles server** | User runs the open-source BlueBubbles server on a Mac; it exposes a REST API + webhooks and speaks to Messages via AppleScript / Private API | Mature, handles tapbacks/attachments/typing, active project, well-documented | User must run and expose a Mac; another moving part we do not control |
| **B. First-party Mac bridge** | Our own helper on the user's Mac: watches `~/Library/Messages/chat.db`, sends via AppleScript/JXA | No third-party dependency; we control the schema and the failure modes; the assistant already has a host bridge (`host_bash`, `assistant/src/tools/host-terminal/host-shell.ts`) reaching the user's Mac through the desktop client | We own `chat.db` schema drift across macOS releases, Full Disk Access onboarding, and the Messages automation permission prompt |
| **C. Hosted relay** (Sendblue, LoopMessage, OpenPhone) | Third party runs the Macs, gives us a normal webhook + REST API | Zero user hardware; ordinary webhook ingress; the pattern the rest of our channels already use | Per-message cost, third party sees message content, numbers can get flagged by Apple, not viable for "the user's own iMessage account" |

**Recommendation: build the bridge boundary first, ship A, keep B behind the
same interface.**

Concretely, the gateway should talk to an *iMessage bridge* over one narrow
interface (§4.2) and never know which implementation is behind it. BlueBubbles
becomes the first adapter because it exists today and already solved tapbacks,
attachments, and the Private API send path. A first-party bridge (option B) is
the better long-term answer for users on the macOS desktop client — we already
have a trusted channel to their Mac — and it slots in behind the same interface
without touching anything in §4.3 onward.

Option C is worth keeping in view for a "get an iMessage number for your
assistant" product, but it is a different feature than "the assistant reads and
answers your iMessage," and it should not drive the architecture.

## 3. Where the meeting-bot pattern fits

The bridge does not have a stable public address, and the gateway may be running
in Docker or in the cloud. Two directions are possible:

- **Gateway dials out to the bridge** (BlueBubbles' REST/socket URL, stored as a
  credential). Mirrors Discord. Works when the bridge is reachable from the
  gateway.
- **Bridge posts in to the gateway.** This is where `channels/ingress.json`
  earns its place: the plugin declares

  ```json
  {
    "routes": [
      {
        "path": "events",
        "kind": "http",
        "description": "Inbound iMessage events from the paired Mac bridge."
      }
    ]
  }
  ```

  and the bridge POSTs to `/webhooks/plugins/imessage/events`, guardian-approved
  via the existing digest flow.

Ship the dial-out direction first (simpler, no public surface, matches Discord).
Add the manifest-declared inbound route for deployments where the Mac cannot be
reached from the gateway. The normalizer is the same in both cases.

### 3.1 The gap this exposes

There is currently **no way for a plugin to inject a trusted inbound message.**
A plugin route handler gets `UserRouteContext` (event hub, conversation posting),
which bypasses `handleInbound` entirely — meaning no `no_one` kill switch, no
trust classification, no admission floor. That is fine for meeting-bot, which
posts transcripts into a conversation the guardian already owns. It is not fine
for a channel where strangers can text in.

So the plan puts the normalizer and `handleInbound` call **in the gateway**, not
in the plugin. The plugin is a transport and a setup experience; the security
boundary stays where it already is.

A genuinely pluggable channel system — where a plugin ships a normalizer and the
gateway runs it through the full admission pipeline — is the right eventual
shape and would make the next channel nearly free. It is deliberately out of
scope here (§7); doing it as a side effect of the first iMessage PR would mean
designing the extension point against a sample size of one.

## 4. Plan

### 4.1 Track A — core vocabulary (this repo)

`ChannelId` is a closed union with `satisfies` guards fanning out across both
services and the web client. The type system does most of the work: adding the
id makes several files fail to compile until they are filled in, which is the
intended experience.

**Vocabulary (do these first; the compiler will find the rest)**

1. `packages/service-contracts/src/channels.ts` — add `"imessage"` to
   `CHANNEL_IDS`. Update `__tests__/channels.test.ts`.
2. `gateway/src/channels/types.ts` — add to the gateway's narrower ingress list
   (the `satisfies readonly CanonicalChannelId[]` clause validates it).
3. `assistant/src/channels/types.ts` — add to the assistant mirror, add a
   `CHANNEL_METADATA` entry (label, subtitle, icon, `supportsVerification`,
   `setupMessages`), and add `"imessage"` to `INTERFACE_IDS`.
4. `assistant/src/channels/config.ts` — `CHANNEL_POLICIES` entry. Proposed:
   `deliveryEnabled: true`, `conversationStrategy: "continue_existing_conversation"`.
   The `satisfies` constraint fails compilation until this exists.
5. `assistant/src/contacts/types.ts` — contact-channel type union.
6. `assistant/src/notifications/signal.ts` — signal descriptor
   (`{ id: "imessage", description: "iMessage" }`).

**Admission and presentation**

7. `packages/gateway-client/src/admission-policy-contract.ts` — add to
   `ADMISSION_POLICY_HIDDEN_CHANNELS` (hidden, still enforced) while ingress is
   credential-gated. Mirror in
   `clients/web/src/lib/channel-admission-policy/types.ts`.
8. `gateway/src/db/seed-admission-policy.ts` — seed `trusted_contacts`. Update
   `gateway/src/__tests__/seed-admission-policy.test.ts`.
9. `clients/web/src/utils/channel-presentation.tsx` — icon and label. Update its
   test.
10. `assistant/src/runtime/routes/channel-availability-routes.ts` — surface
    conditionally on the credential, the way Discord stays out of
    `BASE_AVAILABLE_CHANNELS`.

**Inbound**

11. `gateway/src/channels/inbound-event.ts` — add `"imessage"` to
    `InboundChannelId`, add `IMessageInboundEvent`, add it to the
    `GatewayInboundEvent` union.
12. `gateway/src/imessage/` — new module, organized by concern per
    `gateway/CLAUDE.md`:
    - `message-schemas.ts` — tolerant zod schemas for bridge payloads. Every
      field `.optional().catch(undefined)` except the identity/dedup fields the
      normalizer keys on.
    - `normalize.ts` — bridge payload → `IMessageInboundEvent`. `receivedAt` is
      the gateway's wall clock, never a bridge-supplied timestamp. Preserve the
      original payload verbatim as `raw`.
    - `bridge-client.ts` — the long-lived connection, with reconnect/backoff
      modeled on `gateway/src/discord/backoff.ts` and
      `gateway/src/discord/session-state.ts`.
    - `admit.ts` — which chats to accept (allowlist config), mirroring
      `gateway/src/discord/admit.ts`.
13. `gateway/src/index.ts` — lifecycle block mirroring the Discord one at
    2424-2492: start on credential presence, restart on
    `changed.has("imessage_channel")` (near 2543), stop in shutdown (near 2811).
14. `gateway/src/credential-reader.ts` — register the `imessage_channel` service
    (see the `discord_channel` entry at :318).
15. `gateway/src/channels/transport-hints.ts` — `IMESSAGE_CHANNEL_TRANSPORT_HINTS`
    and a UX brief. iMessage is plain-text-only: no markdown tables, no code
    fences, short messages. Tapbacks are the reaction vocabulary.

**Outbound**

16. `assistant/src/messaging/providers/callback-routing.ts` — add `"imessage"` to
    `DIRECT_DELIVERY_CHANNELS`.
17. `assistant/src/messaging/providers/imessage/transport.ts` — implement
    `ChannelTransport`. `deliver` is required; `sendTyping` and `sendReaction`
    (tapbacks) are worth implementing, since iMessage users read a typing
    indicator as presence.
18. `assistant/src/messaging/providers/index.ts` — register in `TRANSPORTS`.
    Compile-forced by step 16.

**Setup**

19. `skills/imessage-setup/` — SKILL.md plus scripts, mirroring
    `skills/discord-app-setup/` (`check-config.ts`, `store-bot-token.ts`,
    `validate-token.ts`). Register in `skills/catalog.json`. Per
    `gateway/CLAUDE.md`, credential retrieval goes through
    `assistant credentials`, not direct gateway curl.

### 4.2 The bridge interface

Whatever sits behind it, the gateway consumes exactly this:

```ts
interface IMessageBridge {
  /** Long-lived event stream: new messages, edits, tapbacks, read receipts. */
  subscribe(onEvent: (raw: unknown) => void): Promise<void>;
  /** Send text to a chat GUID. */
  send(chatGuid: string, text: string): Promise<{ messageGuid: string }>;
  /** Attach a tapback to a message. */
  react(messageGuid: string, tapback: TapbackKind): Promise<void>;
  /** Typing indicator, where the bridge supports it. */
  setTyping?(chatGuid: string, typing: boolean): Promise<void>;
  /** Fetch an attachment's bytes by id. */
  fetchAttachment?(attachmentGuid: string): Promise<Uint8Array>;
}
```

BlueBubbles is adapter #1. A first-party Mac helper is adapter #2 and changes
nothing above it.

### 4.3 Track B — the plugin repo (`vellum-ai/imessage`)

Layout copied from meeting-bot, which is the established external-plugin shape:

```
hooks/init.ts          resolve config, start the bridge adapter
hooks/shutdown.ts      stop it
channels/ingress.json  declares the inbound POST route (bridge-posts-in mode)
routes/events.ts       receives bridge events when the gateway cannot dial out
skills/imessage-setup/ guides the user through Full Disk Access, pairing, allowlist
src/                   config resolution, bridge adapters, chat.db reader
```

Conventions inherited from meeting-bot's `AGENTS.md`, which apply because the
plugin depends on the same published contract:

- TypeScript + Bun only, explicit `.ts` extensions on intra-repo imports
- `@vellumai/plugin-api` pinned as a `peerDependency`
- no `register.ts`, no host stub, and **no imports from `assistant/src/…`**
- config validated once in `src/config.ts`, resolved copy written to the plugin
  data dir so skill scripts can read it
- credentials resolved from the credential store, never from plugin config

### 4.4 Suggested sequencing

| PR | Contents | Verifiable by |
| --- | --- | --- |
| 1 | Track A vocabulary (steps 1-10). No ingress, no transport. | Typecheck + updated unit tests; `imessage` appears as a hidden, seeded, non-configurable channel |
| 2 | Inbound (11-15) against the BlueBubbles adapter | `normalize.test.ts` over recorded payloads; a real message from a Mac lands in a conversation with the correct trust class |
| 3 | Outbound (16-18) | Reply round-trips; tapback reaction lands |
| 4 | Setup skill (19), graduate out of hidden | A user with no prior context completes setup from the skill alone |
| 5 | Plugin repo: manifest-declared inbound for gateways that cannot dial out | Guardian approval flow works; events arrive over `/webhooks/plugins/imessage/events` |

## 5. Things that will bite

- **Group chats.** The chat GUID is not the sender. `actorExternalId` must be the
  handle, `conversationExternalId` the chat GUID, and the admission floor
  evaluates per sender. A group with one trusted contact and three strangers is
  the normal case, not the edge case.
- **Handle identity is unstable.** The same human appears as `+15551234567` and
  as `person@icloud.com` depending on how the message routed. Contact matching
  has to normalize both, or the same person gets two trust classifications.
- **Green bubbles.** SMS relayed through Messages arrives on the same surface and
  is trivially spoofable. It should be classified more harshly than blue-bubble
  iMessage, and the normalizer should carry the distinction (`service` is
  `iMessage` vs `SMS` in `chat.db`) so admission can act on it.
- **`chat.db` schema drift.** If we go with option B, `attributedBody` is a
  serialized `NSAttributedString` and the plain `text` column is often null on
  recent macOS. This is the single biggest maintenance cost of the first-party
  bridge and the main reason to start with BlueBubbles.
- **Delivery is not confirmation.** AppleScript returns before the message is
  actually sent. Outbound needs to reconcile against the bridge's own event
  stream rather than trusting the send call.
- **Payload size.** Inbound goes through `readLimitedBody()` per
  `gateway/CLAUDE.md`; attachments must be fetched by id, never inlined into the
  event.

## 6. Decisions needed

1. **BlueBubbles first, or first-party Mac bridge first?** The plan assumes
   BlueBubbles, with the bridge interface keeping the first-party path open. If
   we would rather not have users install third-party software, we should say so
   now, because it changes what PR 2 contains (though not the interface).
2. **Does the plugin repo hold the bridge adapters, or does the gateway?** The
   plan puts the normalizer and `handleInbound` call in the gateway (security
   boundary) and the adapters plus setup UX in the plugin. Reasonable people
   could put the adapters in the gateway too and leave the plugin as pure setup.
3. **How harshly do we classify SMS-over-Messages?** Suggest treating it as
   `unknown` regardless of contact match, but that is a product call.
4. **Is `vellum-ai/imessage` the right home**, or should this live in-repo next
   to `gateway/src/discord/`? Every other channel is in-repo. The plugin repo
   makes sense if the Mac-side bridge is the bulk of the code and needs its own
   release cadence; it does not if the answer to (2) is "gateway".

## 7. Out of scope

- A generic pluggable-channel extension point (§3.1). Worth doing, worth doing
  after there are two examples.
- Attachments beyond images in v1.
- Message editing and unsend, which iMessage supports and most channels do not.
- Any hosted-relay product (option C).
