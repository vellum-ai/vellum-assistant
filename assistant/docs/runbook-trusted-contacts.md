# Trusted Contacts — Operator Runbook

Operational procedures for inspecting, managing, and debugging the trusted contact access flow.

Two databases hold this state — pick the right one before reaching for SQL:

| Data                                                                                                                | Database                    | Location                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Contact ACL (`contacts` role, `contact_channels` status/policy/reasons), verification sessions, rate limits, invites | Gateway DB (`gateway.sqlite`) | `$GATEWAY_SECURITY_DIR/gateway.sqlite` (Docker: the `/gateway-security` volume; local fallback: `~/.vellum/protected/`) |
| Access requests (`canonical_guardian_requests`), notification pipeline, contact info/identity mirror                 | Assistant DB (`assistant.db`) | `$VELLUM_WORKSPACE_DIR/data/db/assistant.db`                                                                 |

Prefer the CLI and HTTP surfaces below over raw SQL — they go through the gateway's validation (status vocabulary, revoke-of-blocked guard) and emit the change events clients rely on. Raw SQL is break-glass only.

**Break-glass SQLite rules:** the running gateway holds a live connection to `gateway.sqlite` (and the daemon to `assistant.db`). Open read-only for inspection (`sqlite3 "file:$GW_DB?mode=ro"`). For writes, stop the services first (`vellum sleep`), run the statement, then `vellum wake` — a write against a live DB races the owning process and can hit SQLite lock contention.

## Prerequisites

```bash
# Base URL — gateway (adjust if GATEWAY_PORT overrides the default)
BASE=http://localhost:7830

# Bearer token: for operator use, retrieve from the daemon process environment
# or use `assistant` CLI commands which handle auth automatically over IPC.
TOKEN=<your-bearer-token>

# Break-glass DB paths
GW_DB="$GATEWAY_SECURITY_DIR/gateway.sqlite"          # local default: ~/.vellum/protected/gateway.sqlite
AST_DB="$VELLUM_WORKSPACE_DIR/data/db/assistant.db"
```

## 1. Inspect Trusted Contacts

### Via CLI (preferred)

```bash
assistant contacts list --role contact
assistant contacts list --role guardian
assistant contacts list --channel-type telegram
assistant contacts get <contactId>
```

### Via HTTP API

```bash
# List all active trusted contacts
curl -s "$BASE/v1/contacts?role=contact" \
  -H "Authorization: Bearer $TOKEN" | jq

# Telegram contacts only
curl -s "$BASE/v1/contacts?channelType=telegram" \
  -H "Authorization: Bearer $TOKEN" | jq

# Voice contacts only
curl -s "$BASE/v1/contacts?channelType=phone" \
  -H "Authorization: Bearer $TOKEN" | jq

# All contacts (including revoked and blocked)
curl -s "$BASE/v1/contacts" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Response shape (ACL fields come from the gateway DB; info fields like `notes` are joined from the assistant DB):

```json
{
  "ok": true,
  "contacts": [
    {
      "id": "uuid",
      "displayName": "Alice",
      "role": "contact",
      "notes": null,
      "contactType": "human",
      "principalId": null,
      "interactionCount": 12,
      "createdAt": 1699000000000,
      "updatedAt": 1700000000000,
      "channels": [
        {
          "id": "channel-uuid",
          "contactId": "uuid",
          "type": "telegram",
          "address": "123456789",
          "isPrimary": true,
          "externalChatId": "123456789",
          "externalUserId": "123456789",
          "status": "active",
          "policy": "allow",
          "verifiedAt": 1699500000000,
          "verifiedVia": "challenge",
          "revokedReason": null,
          "blockedReason": null,
          "lastSeenAt": 1700000000000,
          "createdAt": 1699000000000
        }
      ]
    }
  ]
}
```

`address` is the canonical channel identity (Telegram user ID, E.164 phone number, etc.). `externalUserId` in responses is a compat alias for `address` — the gateway `contact_channels` table itself has no `external_user_id` column.

## 2. Inspect Pending Access Requests

Access requests live in the **assistant DB** table `canonical_guardian_requests` (`kind = 'access_request'`, `tool_name = 'ingress_access_request'`).

```bash
sqlite3 "file:$AST_DB?mode=ro" \
  "SELECT id, source_channel, requester_external_user_id, requester_chat_id, \
   guardian_external_user_id, status, request_code, created_at, expires_at \
   FROM canonical_guardian_requests \
   WHERE kind = 'access_request' AND status = 'pending' \
   ORDER BY created_at DESC;"
```

### Check all access requests (including resolved)

```bash
sqlite3 "file:$AST_DB?mode=ro" \
  "SELECT id, source_channel, requester_external_user_id, status, \
   decided_by_external_user_id, created_at \
   FROM canonical_guardian_requests \
   WHERE kind = 'access_request' \
   ORDER BY created_at DESC LIMIT 20;"
```

## 3. Inspect Pending Verification Sessions

Verification sessions live in the **gateway DB** table `channel_verification_sessions`. Live sessions are in one of the interceptable statuses — `pending` (inbound guardian challenge), `pending_bootstrap` (unbound bootstrap), `awaiting_response` (identity-bound outbound) — with `expires_at > now`.

```bash
sqlite3 "file:$GW_DB?mode=ro" \
  "SELECT id, channel, status, verification_purpose, identity_binding_status, \
   expected_external_user_id, expected_chat_id, expected_phone_e164, \
   expires_at, created_at \
   FROM channel_verification_sessions \
   WHERE status IN ('pending', 'pending_bootstrap', 'awaiting_response') \
   AND expires_at > $(date +%s)000 \
   ORDER BY created_at DESC;"
```

`verification_purpose` is `guardian` for guardian binding flows and `trusted_contact` for the access-request handshake.

## 4. Force-Revoke a Trusted Contact

### Via CLI (preferred)

```bash
# Find the channel ID
assistant contacts list --channel-address "TARGET_ADDRESS"
assistant contacts get <contactId>

# Revoke with reason
assistant contacts channels update-status <channelId> --status revoked --reason "Revoked by operator"

# Block (stronger than revoke — cannot re-enter the flow without explicit unblocking)
assistant contacts channels update-status <channelId> --status blocked --reason "Blocked by operator"
```

### Via HTTP API

```bash
# Find the contact's channel ID (address = canonical channel identity)
CHANNEL_ID=$(curl -s "$BASE/v1/contacts?channelType=telegram" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.contacts[].channels[] | select(.address == "TARGET_ADDRESS") | .id')

# Revoke with reason
curl -s -X PATCH "$BASE/v1/contact-channels/$CHANNEL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "revoked", "reason": "Revoked by operator"}' | jq

# Block
curl -s -X PATCH "$BASE/v1/contact-channels/$CHANNEL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "blocked", "reason": "Blocked by operator"}' | jq
```

### Via SQLite (emergency)

If both the CLI and HTTP API are unavailable, write the **gateway DB** — it is the ACL source of truth; the assistant DB carries no ACL columns. Stop the gateway first. Channel identity is `(type, address)`.

```bash
sqlite3 "$GW_DB" \
  "UPDATE contact_channels \
   SET status = 'revoked', revoked_reason = 'Emergency operator revocation', \
   updated_at = $(date +%s)000 \
   WHERE type = 'telegram' AND address = 'TARGET_ADDRESS';"
```

Note: raw SQL bypasses the API's guard that refuses to downgrade a `blocked` channel to `revoked` — check the current status first.

## 5. Debug Verification Failures

### Check rate limit state

If a user is getting "invalid or expired code" errors, they may be rate-limited. Rate limits live in the **gateway DB** — one row per actor with a sliding window of attempt timestamps:

```bash
sqlite3 "file:$GW_DB?mode=ro" \
  "SELECT channel, actor_external_user_id, actor_chat_id, \
   attempt_timestamps_json, locked_until, updated_at \
   FROM channel_guardian_rate_limits \
   WHERE actor_external_user_id = 'TARGET_USER_ID' \
   OR actor_chat_id = 'TARGET_CHAT_ID';"
```

The actor is locked out while `locked_until` is in the future.

### Reset rate limits for a user

Stop the gateway first, then:

```bash
sqlite3 "$GW_DB" \
  "DELETE FROM channel_guardian_rate_limits \
   WHERE actor_external_user_id = 'TARGET_USER_ID' AND channel = 'telegram';"
```

### Check verification session state

```bash
sqlite3 "file:$GW_DB?mode=ro" \
  "SELECT id, channel, status, verification_purpose, identity_binding_status, \
   expected_external_user_id, expected_chat_id, expected_phone_e164, \
   expires_at, consumed_by_external_user_id, consumed_by_chat_id \
   FROM channel_verification_sessions \
   WHERE expected_external_user_id = 'TARGET_USER_ID' \
   OR expected_chat_id = 'TARGET_CHAT_ID' \
   ORDER BY created_at DESC LIMIT 5;"
```

### Common verification failure causes

| Symptom                                                | Likely cause                                                                     | Resolution                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Invalid or expired code" (correct code)               | Identity mismatch: the code was entered from a different user/chat than expected | Verify the requester is using the same account that originally requested access                                                                                |
| "Invalid or expired code" (correct code, correct user) | Rate-limited (5+ failures in 15 min window)                                      | Wait 30 minutes or reset rate limits via SQLite (gateway DB)                                                                                                   |
| "Invalid or expired code" (old code)                   | Code TTL expired (10 min)                                                        | Guardian must re-approve to generate a new code                                                                                                                |
| "Invalid or expired code" (blocked/revoked channel)    | The gateway ACL row for this actor is `blocked` (or `revoked` for contact flows) | A correct code does not restore trust for a blocked actor. Unblock the channel first (see §4), then re-run the flow                                            |
| Code never delivered to guardian                       | `deliverChannelReply` failed                                                     | Check daemon logs for "Failed to deliver verification code to guardian"                                                                                        |
| No notification to guardian                            | No guardian binding resolvable                                                   | Verify with `assistant contacts list --role guardian`: the gateway `contacts` table needs a `role = 'guardian'` row with an active `contact_channels` entry |

## 6. Check Notification Delivery Status

These tables live in the **assistant DB**. Deliveries hang off decisions (`notification_deliveries.notification_decision_id` → `notification_decisions.id` → `notification_events.id`).

### Check if the access request notification was decided

```bash
sqlite3 "file:$AST_DB?mode=ro" \
  "SELECT ne.id, ne.source_event_name, ne.dedupe_key, ne.created_at, \
   nd.should_notify, nd.selected_channels, nd.confidence \
   FROM notification_events ne \
   LEFT JOIN notification_decisions nd ON nd.notification_event_id = ne.id \
   WHERE ne.source_event_name LIKE 'ingress.%' \
   ORDER BY ne.created_at DESC LIMIT 20;"
```

### Check delivery records

```bash
sqlite3 "file:$AST_DB?mode=ro" \
  "SELECT ndel.id, ndel.channel, ndel.status, ndel.error_message, \
   ndel.created_at, ne.source_event_name \
   FROM notification_deliveries ndel \
   JOIN notification_decisions nd ON nd.id = ndel.notification_decision_id \
   JOIN notification_events ne ON ne.id = nd.notification_event_id \
   WHERE ne.source_event_name LIKE 'ingress.%' \
   ORDER BY ndel.created_at DESC LIMIT 20;"
```

### Check lifecycle signals

```bash
sqlite3 "file:$AST_DB?mode=ro" \
  "SELECT source_event_name, source_channel, dedupe_key, created_at \
   FROM notification_events \
   WHERE source_event_name LIKE 'ingress.trusted_contact.%' \
   ORDER BY created_at DESC LIMIT 20;"
```

## 7. Manually Add a Trusted Contact (Bypass Verification)

If the verification flow cannot be completed, an operator can directly create an active contact. The upsert writes the gateway ACL (source of truth) and mirrors identity/info to the assistant DB:

```bash
curl -s -X POST "$BASE/v1/contacts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "displayName": "Alice",
    "channels": [{
      "type": "telegram",
      "address": "123456789",
      "externalChatId": "123456789",
      "status": "active",
      "policy": "allow"
    }]
  }' | jq
```

For voice contacts, use the E.164 phone number as the address:

```bash
curl -s -X POST "$BASE/v1/contacts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "displayName": "Bob",
    "channels": [{
      "type": "phone",
      "address": "+12125550142",
      "externalChatId": "+12125550142",
      "status": "active",
      "policy": "allow"
    }]
  }' | jq
```

To mark an existing unverified channel verified without the code handshake, use the manual verify endpoint (guardian-authenticated; stamps `verifiedVia: "manual"`):

```bash
curl -s -X POST "$BASE/v1/contact-channels/$CHANNEL_ID/verify" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## 8. Clean Up Expired Data

### Purge expired verification sessions

Expired sessions are already invisible to the verification flow (every lookup filters on `expires_at`), but you can clean them out of the **gateway DB** (stop the gateway first):

```bash
sqlite3 "$GW_DB" \
  "DELETE FROM channel_verification_sessions \
   WHERE expires_at < $(date +%s)000 \
   AND status IN ('pending', 'pending_bootstrap', 'awaiting_response');"
```

### Expire stale access requests

The daemon's `sweepExpiredCanonicalGuardianRequests()` timer handles this automatically every 60 seconds (it also withdraws the approval cards and notifies the requester). Manual fallback against the **assistant DB**:

```bash
sqlite3 "$AST_DB" \
  "UPDATE canonical_guardian_requests \
   SET status = 'expired' \
   WHERE status = 'pending' AND expires_at < $(date +%s)000;"
```
