---
name: "A2A Connections"
description: "Manage assistant-to-assistant connections — generate invites, redeem invite codes, exchange verification codes, list connections, and revoke peers"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83e\udd1d"}}
---

You are helping your user manage assistant-to-assistant (A2A) connections. A2A connections let two Vellum assistants communicate directly, enabling cross-assistant collaboration, delegation, and message passing. Local operations (invite, redeem, approve, revoke, list) go through the local gateway with bearer auth. Peer-facing operations (connect, verify, status polling on the connecting side) target the peer's public gateway and are unauthenticated (invite-token or handshake-gated).

## Prerequisites

- Use the injected `INTERNAL_GATEWAY_BASE_URL` for gateway API calls.
- Use gateway routes only: this skill calls `/v1/a2a/*` on the gateway, never the daemon runtime port directly.
- The bearer token is stored at `~/.vellum/http-token`. Read it with: `TOKEN=$(cat ~/.vellum/http-token)`.
- Run shell commands for this skill with `host_bash` (not sandbox `bash`) so host auth/token and gateway routing are reliable.
- A public ingress URL must be configured for invite generation (so peers can reach this assistant). If not set, load and execute the **public-ingress** skill first.

## Concepts

- **Connection**: A bidirectional link between this assistant and a peer assistant. Each connection has a status lifecycle: `pending` -> `active` (or `revoked`/`expired`).
- **Invite code**: A base64url-encoded string containing this assistant's gateway URL and a one-time token. Share this with the person running the other assistant. Invites expire after 24 hours by default.
- **Verification code**: A short numeric code exchanged out-of-band (e.g., read aloud, texted) to prove both sides are who they claim. The inviting side receives the code after approving; the redeeming side submits it.
- **Handshake flow**: Generate invite -> Peer redeems invite -> Peer sends connect request -> Guardian approves -> Verification code exchange -> Connection active.

## Available Actions

### 1. Generate an invite

Use this when the user wants to invite another assistant to connect. This creates a one-time invite code that the other assistant's guardian can redeem.

First, retrieve the public gateway URL:

```bash
TOKEN=$(cat ~/.vellum/http-token)
GATEWAY_URL=$(vellum config get ingress.publicBaseUrl 2>/dev/null | tr -d '[:space:]')

if [ -z "$GATEWAY_URL" ]; then
  echo "error:no_public_ingress"
  exit 1
fi

RESULT=$(curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/invite" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"gatewayUrl\": \"$GATEWAY_URL\",
    \"note\": \"<optional note, e.g. who this invite is for>\"
  }")
printf '%s\n' "$RESULT"
```

Optional fields in the request body:
- `expiresInMs` -- expiration time in milliseconds from now (default: 24 hours)
- `note` -- a human-readable label for the invite
- `idempotencyKey` -- prevents duplicate invites if retried

The response contains `{ inviteCode, inviteId }`.

**Presenting to the user**: The invite code is a long base64url string. Present it clearly with copy instructions:

> Here is your A2A connection invite code:
>
> `<inviteCode>`
>
> Share this code with the person running the other assistant. They should tell their assistant: "Connect to [paste invite code]". The code expires in 24 hours and can only be used once.

If the public ingress URL is not configured (`error:no_public_ingress`), tell the user they need to set up public ingress first. Offer to load the **public-ingress** skill.

### 2. Redeem an invite code

Use this when the user has received an invite code from another assistant's guardian and wants to connect. This decodes the invite and retrieves the peer's gateway URL.

```bash
TOKEN=$(cat ~/.vellum/http-token)
RESULT=$(curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/redeem" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"inviteCode\": \"<invite_code>\"}")
printf '%s\n' "$RESULT"
```

The response contains `{ peerGatewayUrl, inviteId }` on success.

On success, immediately proceed to initiate the connection (Action 3) using the returned `peerGatewayUrl` and invite token from the decoded invite. Do not wait for the user to ask.

### 3. Initiate a connection

After redeeming an invite, send a connect request to the **peer's** gateway (the `peerGatewayUrl` returned by the redeem step). The peer's daemon validates the invite token and creates a pending connection. The peer's guardian will be notified and must approve.

The connect endpoint is **unauthenticated** at the gateway level — access is gated by the invite token, not bearer auth. The `peerGatewayUrl` in the request body is this assistant's own public gateway URL, so the peer knows how to reach back.

```bash
# PEER_GATEWAY_URL comes from the redeem response (Action 2).
# OWN_GATEWAY_URL is this assistant's public ingress URL.
OWN_GATEWAY_URL=$(vellum config get ingress.publicBaseUrl 2>/dev/null | tr -d '[:space:]')

RESULT=$(curl -s -X POST "${PEER_GATEWAY_URL}/v1/a2a/connect" \
  -H "Content-Type: application/json" \
  -d "{
    \"peerGatewayUrl\": \"$OWN_GATEWAY_URL\",
    \"inviteToken\": \"<invite_token>\"
  }")
printf '%s\n' "$RESULT"
```

The response contains `{ connectionId, handshakeSessionId }` on success (HTTP 201).

After a successful connect request, tell the user:

> Connection request sent. The other assistant's guardian needs to approve it. Once approved, they will receive a verification code to share with you. When you have the code, tell me: "the code is [digits]".

### 4. Approve a pending connection

When a peer sends a connect request, the guardian is notified. Use this action when the user wants to approve (or deny) a pending connection. The approval response includes a verification code that must be shared out-of-band with the peer.

```bash
TOKEN=$(cat ~/.vellum/http-token)
RESULT=$(curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/approve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"connectionId\": \"<connection_id>\",
    \"decision\": \"approve\"
  }")
printf '%s\n' "$RESULT"
```

The `decision` field accepts `"approve"` or `"deny"`.

On approval, the response contains `{ verificationCode, connectionId }`.

**Presenting the verification code**: This code must be communicated out-of-band to the peer's guardian (e.g., read aloud, sent via text message, shown in person). Never transmit it through the A2A connection itself.

> Connection approved. Here is the verification code:
>
> **`<verificationCode>`**
>
> Share this code with the other assistant's guardian through a separate channel (text, phone call, in person). They will enter it into their assistant to complete the connection.

On denial, the response is `{ ok: true }` and the connection is rejected.

### 5. Submit a verification code

Use this when the user has received a verification code from the peer's guardian (after the peer approved the connection request). This completes the handshake and activates the connection.

The verify endpoint is called on the **peer's** gateway (the same gateway that received the connect request). It is unauthenticated — the combination of `connectionId` + `code` + `peerIdentity` serves as the auth factor.

```bash
# PEER_GATEWAY_URL is the same peer gateway URL used in the connect step.
RESULT=$(curl -s -X POST "${PEER_GATEWAY_URL}/v1/a2a/verify" \
  -H "Content-Type: application/json" \
  -d "{
    \"connectionId\": \"<connection_id>\",
    \"code\": \"<verification_code>\",
    \"peerIdentity\": \"<peer_gateway_url>\"
  }")
printf '%s\n' "$RESULT"
```

On success, the response contains `{ connectionId, status: "active" }`.

Tell the user: "Connection is now active! You and the other assistant can now communicate."

### 6. List connections

Use this to show the user their current A2A connections.

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/connections" \
  -H "Authorization: Bearer $TOKEN"
```

Optional query parameter:
- `status` -- filter by connection status (`pending`, `active`, `revoked`, `expired`)

Example with filter:
```bash
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/connections?status=active" \
  -H "Authorization: Bearer $TOKEN"
```

The response contains `{ connections: [...] }` where each connection has:
- `id` -- unique connection ID
- `peerGatewayUrl` -- the peer's gateway URL
- `peerDisplayName` -- human-readable name (may be null)
- `status` -- current status (`pending`, `active`, `revoked`, `revoked_by_peer`, `expired`)
- `protocolVersion` -- negotiated protocol version
- `capabilities` -- negotiated capabilities
- `createdAt` -- when the connection was created
- `updatedAt` -- last status change

**Presenting results**: Format as a readable list. Show peer display name (or gateway URL as fallback), status, and creation date. If no connections exist, tell the user they have no A2A connections yet and offer to generate an invite.

### 7. Check connection status

Use this to poll the status of a specific connection (e.g., while waiting for the peer to approve or verify).

When polling a connection created by a connect request (the connecting side), call the **peer's** gateway — the connection record lives on the peer's daemon:

```bash
# PEER_GATEWAY_URL is the same peer gateway URL used in the connect step.
curl -s "${PEER_GATEWAY_URL}/v1/a2a/connections/<connection_id>/status"
```

When checking a connection that exists locally (the inviting side), use the local gateway:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/connections/<connection_id>/status" \
  -H "Authorization: Bearer $TOKEN"
```

The response contains `{ connectionId, status, peerGatewayUrl, protocolVersion, createdAt, updatedAt }`.

### 8. View connection scopes

Use this to show the user what scopes (permissions) are granted to a specific A2A connection. Scopes control what actions a peer assistant can perform.

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/connections/<connection_id>/scopes" \
  -H "Authorization: Bearer $TOKEN"
```

The response contains `{ connectionId, scopes }` where `scopes` is an array of scope IDs.

Available scope IDs and their meanings:
- `message` -- Send and receive text messages
- `read_availability` -- Read calendar free/busy information
- `create_events` -- Create calendar events (medium risk)
- `read_profile` -- Read basic profile info (name, timezone)
- `execute_requests` -- Execute structured A2A requests (high risk)

**Presenting results**: Show the scopes as a readable list with their descriptions. If no scopes are granted, tell the user no permissions are currently set for this connection.

### 9. Update connection scopes

Use this when the user wants to grant or revoke specific permissions for a peer connection. **Scope changes take effect immediately** -- the peer's next request will be evaluated against the updated scopes.

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X PUT "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/connections/<connection_id>/scopes" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"scopes\": [\"message\", \"read_profile\"]}"
```

The `scopes` array replaces the existing scopes entirely. To add a scope, include it alongside existing ones. To remove a scope, omit it from the array.

The response contains `{ connectionId, previousScopes, newScopes }`.

**Presenting results**: Show what changed clearly:
> Updated scopes for [peer name or URL]:
> - Added: `read_profile`
> - Removed: `create_events`
> - Current scopes: `message`, `read_profile`

**Confirmation**: Granting high-risk scopes (`execute_requests`, `create_events`) should be confirmed with the user before proceeding. Revoking scopes or granting low-risk scopes (`message`, `read_profile`, `read_availability`) does not require extra confirmation.

### 10. Revoke a connection

Use this when the user wants to disconnect from a peer. **Always confirm with the user before revoking.**

Ask the user: *"I'll revoke the connection to [peer name or URL]. This will sever the link and the peer will no longer be able to communicate with this assistant. Should I proceed?"*

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/a2a/revoke" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"connectionId\": \"<connection_id>\"}"
```

On success, the response is `{ ok: true }`.

## Confirmation Requirements

**Revoking a connection requires explicit user confirmation before execution.** Modifying who can communicate with the assistant should always be a deliberate choice.

**Granting high-risk scopes** (`execute_requests`, `create_events`) requires explicit user confirmation. Granting low-risk scopes or revoking any scope does not require extra confirmation.

Generating invites, redeeming invites, and approving/denying connections do not require additional confirmation since the user is explicitly initiating those actions.

## Error Handling

If a request returns an error JSON (typically `{ error: { code, message } }`), report the error clearly. Common errors:

| Error | Meaning | Action |
|---|---|---|
| `Missing required field: gatewayUrl` | Public ingress not configured | Tell the user to set up public ingress first. Offer to load the **public-ingress** skill. |
| `Missing required field: inviteCode` | No invite code provided | Ask the user for the invite code they received. |
| `malformed_invite` (400) | The invite code is corrupted or invalid | Ask the user to double-check the invite code. It should be a long base64url string. |
| `invalid_or_expired` (404) | The invite has expired or does not exist | Tell the user the invite is no longer valid. Ask the peer's guardian to generate a new one. |
| `already_redeemed` (409) | The invite was already used | Tell the user this invite has already been consumed. A new invite is needed. |
| `invite_not_found` (404) | The invite token was not recognized by the peer | The invite may have expired on the peer's side. Ask for a fresh invite. |
| `invite_consumed` (409) | The invite was already used to establish a connection | A new invite is needed from the peer. |
| `version_mismatch` (400) | Protocol version incompatibility | Tell the user the two assistants are running incompatible versions. Both need to update. |
| `not_found` (404) | Connection ID not recognized | The connection may have been deleted. List connections to verify. |
| `invalid_state` (409) | Connection is not in the right state for the requested action | The connection may have already been approved, denied, or revoked. Check status. |
| `already_resolved` (409) | The approval decision was already made | Someone already approved or denied this connection. |
| `invalid_code` (403) | Wrong verification code | Ask the user to double-check the code with the peer's guardian. |
| `expired` (410) | The verification code or handshake session expired | The handshake timed out. The peer needs to send a new connect request. |
| `max_attempts` (429) | Too many incorrect code attempts | Rate limited. Wait and try again, or revoke and start fresh. |
| `identity_mismatch` (403) | The peer identity does not match the connection | The verification is being attempted from the wrong peer. |
| `invalid_scopes` (400) | One or more scope IDs are not recognized | Check the scope IDs against the available list: `message`, `read_availability`, `create_events`, `read_profile`, `execute_requests`. |
| `not_active` (409) | Connection is not active (scopes can only be managed on active connections) | The connection must be fully established before managing scopes. |
| HTTP 429 (rate limited) | Too many requests | Tell the user to wait a moment before retrying. The response includes a `Retry-After` header. |
| HTTP 502/504 (gateway error) | Peer assistant unreachable | The peer's gateway may be offline. Ask the user to confirm the peer is running and try again later. |

## Typical Workflows

**"Connect me to another assistant"** / **"Generate a connection invite"**:
1. Generate an invite (Action 1)
2. Present the invite code to the user with sharing instructions

**"Connect to [invite code]"** / **"I have an invite code"**:
1. Redeem the invite (Action 2)
2. Automatically initiate the connection (Action 3)
3. Tell the user to wait for approval and a verification code

**"The code is [digits]"** / **"Verification code: [digits]"**:
1. Look up the pending connection (list connections filtered by `status=pending`)
2. Submit the verification code (Action 5)
3. Confirm the connection is active

**"Show my connections"** / **"Who am I connected to?"**:
1. List connections (Action 6), optionally filtered by status

**"Disconnect from [name/URL]"** / **"Revoke connection to [name]"**:
1. List connections to identify the target
2. Confirm with the user
3. Revoke the connection (Action 10)

**"Allow messaging with [connection]"** / **"Grant message scope to [name]"**:
1. List connections to identify the target (Action 6)
2. Get current scopes (Action 8)
3. Add the requested scope to the existing list
4. Update scopes (Action 9)

**"Revoke calendar access from [connection]"** / **"Remove create_events scope"**:
1. List connections to identify the target (Action 6)
2. Get current scopes (Action 8)
3. Remove the specified scope from the list
4. Update scopes (Action 9)

**"Show scopes for [connection]"** / **"What can [name] do?"**:
1. List connections to identify the target (Action 6)
2. Get scopes (Action 8)
3. Present the scopes with descriptions

**Incoming connection request (notification)**:
When the assistant receives a notification about a pending connection request from a peer, present it to the guardian and ask whether to approve or deny. If approved, display the verification code with out-of-band sharing instructions.

**"Check status of my connection"**:
1. List connections or check specific connection status (Action 7)
2. Report the current state
