# Channels

Make a route reachable from the public internet. A plugin is a channel because it declares ingress: `channels/ingress.json` is the list of routes the outside world may reach it on.

The gateway owns the public surface: it validates the declaration, signature-checks every request, and holds `plugin`-signed routes behind a guardian's approval. Plugins that declare a channel ingress are considered themselves a channel in all contexts where channels are viewed.

## When to declare ingress

Use this surface when a third party must deliver to the assistant from outside: a vendor webhook, a realtime socket a third party dials, or a channel that should appear next to Slack and Telegram. Use a [route](routes.md) alone when the caller is already inside the assistant (an app frontend, a local tool, another plugin).

## The declaration

`channels/ingress.json` is a JSON object with a non-empty `routes` array. The plugin's identity comes from its directory, not from the file, so a manifest cannot claim to belong to a different plugin. Declare the public path in `ingress.json` **and** implement the matching handler under `routes/` at the same relative path.

```json
{
  "routes": [
    {
      "path": "events",
      "kind": "http",
      "description": "Inbound events from Example Courier"
    }
  ]
}
```

That route is served at `/webhooks/plugins/<plugin-name>/events` and handled by `routes/events.ts`. Resolve the URL to hand a vendor with `resolveWebhookUrl({ path: "events" })` from `@vellumai/plugin-api`. Do not hardcode a hostname. Do not tell a vendor to POST at `/x/plugins/...`.

### Route fields

| Field          | Required | Default            | Notes                                                                                                                                                                                                                                         |
| -------------- | -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`         | yes      |                    | Relative to the plugin's own namespace (`"events"`, not `/webhooks/plugins/my-plugin/events`). No leading slash, no trailing slash, no query or fragment, no `.` or `..` segments, and canonical (unencoded, no empty or redundant segments). |
| `kind`         | yes      |                    | `"http"` or `"websocket"`. The gateway bridges the two differently, so the kind has to be known before a connection arrives.                                                                                                                  |
| `description`  | yes      |                    | Human-readable purpose, surfaced in gateway logs and the approval UI.                                                                                                                                                                         |
| `handshake`    | no       | `"signed-headers"` | Where the caller carries its signature. `"signed-headers"` (default) puts it in request headers. `"signed-query"` puts the same HMAC in the URL, WebSocket only, for a caller that is handed a URL and nothing else.                          |
| `verification` | no       | vendor HMAC        | How a third-party caller's signature is checked. HTTP only.                                                                                                                                                                                   |
| `inbound`      | no       | webhook only       | That this route's replies carry inbound messages, and how to read them. HTTP only.                                                                                                                                                            |

Duplicate paths in one file fail the whole declaration. A malformed file disables ingress for that plugin only; sibling plugins keep theirs.

## Approval and signatures

Every public plugin route is signature-checked. An unsigned plugin route does not exist. A route whose signing secret is missing is refused rather than served unsigned, and an unauthenticated probe sees `404` whether the route is undeclared, pending, or missing a secret.

A guardian has to approve the declaration before the gateway serves it. The approval covers a digest of the declaration: adding a route, changing transport, handshake, verification, or inbound delivery drops the plugin back to pending. Rewording `description` does not. Editing the file and reinstalling is not enough; the guardian has to approve the new digest.

Ask the user to approve pending ingress from the channels settings once the plugin is installed. A plugin must not approve its own ingress.

## Third-party verification

A vendor that signs `X-Example-Signature` has its own scheme. Declare `verification` so the gateway runs one HMAC engine and reads the vendor's specifics as data:

```json
{
  "path": "events",
  "kind": "http",
  "description": "Inbound deliveries from Example Courier",
  "verification": {
    "kind": "hmac",
    "algorithm": "sha256",
    "secret": { "field": "courier_webhook_secret" },
    "signature": {
      "header": "X-Example-Signature",
      "encoding": "hex",
      "prefix": "sha256="
    },
    "payload": ["body"],
    "freshness": {
      "header": "X-Example-Timestamp",
      "format": "unix-seconds",
      "toleranceSeconds": 300
    }
  }
}
```

Rules that stay gateway-side:

- The credential **service** is the plugin's directory name. The descriptor names only a **field** (`courier_webhook_secret` above). A manifest cannot point a route at another plugin's secret or at the platform's.
- Store the secret via `assistant credentials prompt` (or `storeCredential` from a hook/tool/route). Never put it in the file.
- `payload` is the exact bytes the vendor signs, in order: `"body"`, `{ "header": "..." }`, or `{ "literal": "..." }`. A header named in `payload` but absent from the request fails verification rather than contributing an empty string.
- `freshness` is a replay window. Declare it when the vendor binds a timestamp. A signature over the body alone stays valid for as long as the secret does.
- Unrecognized fields fail the declaration rather than guessing a scheme.

## Delivering inbound messages

Absent `inbound`, the route is a webhook and nothing more: the gateway forwards the delivery, returns whatever the plugin answered, and the message goes no further.

Present, the plugin's **reply** is normalized and run through the gateway's inbound pipeline (admission floor, trust verdict, verification and invite intercepts), exactly as a built-in channel's would be. The plugin parses the vendor payload. The declaration tells the gateway where the sender and the conversation sit so the gate can run before anything is forwarded.

A plugin that returns the default envelope declares `"inbound": {}` and nothing more:

```json
{
  "path": "events",
  "kind": "http",
  "description": "Messages from Example Courier",
  "inbound": {}
}
```

The matching route handler replies with:

```json
{
  "message": {
    "content": "hello",
    "conversationExternalId": "chat-123",
    "externalMessageId": "msg-123"
  },
  "actor": {
    "actorExternalId": "+12025550142",
    "displayName": "Alice"
  },
  "source": { "chatType": "dm" }
}
```

A reply with no sender and no conversation is a plain acknowledgement (delivery receipt, vendor probe). Naming some of those fields and not the rest is invalid and is logged rather than quietly dropped.

Override field locations when the vendor's payload is not that shape. Paths are dotted identifiers (`message.body`), not JSONPath. `from` may list several paths (first non-empty wins). `map` / `default` turn a vendor vocabulary into ours:

```json
{
  "inbound": {
    "identity": "phone",
    "fields": {
      "content": "message.body",
      "conversationExternalId": ["message.conversation_id", "message.from"],
      "externalMessageId": "message.id",
      "actorExternalId": "message.from",
      "chatType": {
        "from": "message.channel",
        "map": { "imessage": "imessage" },
        "default": "sms"
      }
    }
  }
}
```

`identity` is `"opaque"` (default), `"phone"`, or `"email"`. It decides whether `+1 (202) 555-0142` and `+12025550142` are the same person. Leave it `opaque` unless the sender id really is a phone number or email; rewriting an id that was already canonical is how a returning sender stops matching their contact record.

What the plugin does not get to decide:

- **Channel.** The gateway stamps `plugin`. A reply that claims `slack` is ignored, so a plugin cannot inherit Slack's admission floor or contact records.
- **External ids.** Every id is prefixed with the plugin's directory name (`courier:+12025550142`). Two plugins whose vendors both address by phone number do not share conversations or contacts.

## Presentation

The channels list reads the plugin's `package.json`, not the ingress file:

```json
{
  "name": "example-courier",
  "displayName": "Courier",
  "description": "Reach the assistant by carrier pigeon.",
  "icon": "send"
}
```

`displayName`, `description`, and `icon` (a Lucide name without the `lucide-` prefix) are optional and none gate anything. A plugin with ingress and a bare `package.json` still appears, titled from its directory (`example-courier` becomes "Example Courier"). A plugin whose directory name is already a built-in channel (`slack`, `telegram`, …) is skipped so it cannot impersonate one.

Disabled plugins contribute no channel.

## Anatomy

```
example-courier/
├── package.json
├── channels/
│   └── ingress.json
└── routes/
    └── events.ts
```

```json
{
  "routes": [
    {
      "path": "events",
      "kind": "http",
      "description": "Inbound events from Example Courier",
      "inbound": {}
    }
  ]
}
```

```ts
// routes/events.ts
export async function POST(request: Request): Promise<Response> {
  const delivery = await request.json();
  return Response.json({
    message: {
      content: delivery.text ?? "",
      conversationExternalId: delivery.chatId,
      externalMessageId: delivery.messageId,
    },
    actor: {
      actorExternalId: delivery.from,
      displayName: delivery.fromName,
    },
  });
}
```

Hand the vendor `await resolveWebhookUrl({ path: "events" })`. After install, the guardian approves the pending ingress from channels settings, and deliveries that carry a sender start conversations on this plugin channel.
