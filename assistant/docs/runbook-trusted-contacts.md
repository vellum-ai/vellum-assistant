# Trusted Contacts — Operator Runbook

Operational procedures for inspecting, managing, and debugging the trusted contact access flow. HTTP commands use the assistant runtime API (default `http://localhost:7821`) with bearer authentication.

> **Note:** The `/v1/contacts` endpoints are served by the assistant runtime, not
> the gateway. If you prefer to route through the gateway (`localhost:7830`), set
> `GATEWAY_RUNTIME_PROXY_ENABLED=true` in the gateway environment — the proxy is
> disabled by default and these routes will 404 without it.

## Prerequisites

```bash
# Base URL — assistant runtime (adjust if using a non-default port)
BASE=http://localhost:7821

# Bearer token: if running via the assistant's shell tools, $GATEWAY_AUTH_TOKEN
# is injected automatically. For manual operator use, mint a token via the CLI
# or use one from the daemon (e.g. from a recent shell env export).
TOKEN=$GATEWAY_AUTH_TOKEN
```

## 1. Inspect Trusted Contacts

### List all active trusted contacts

```bash
curl -s "$BASE/v1/contacts?role=contact" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Filter by channel type

```bash
# Telegram contacts only
curl -s "$BASE/v1/contacts?channelType=telegram" \
  -H "Authorization: Bearer $TOKEN" | jq

# SMS contacts only
curl -s "$BASE/v1/contacts?channelType=sms" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### List all contacts (including revoked and blocked)

```bash
curl -s "$BASE/v1/contacts" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Via CLI

```bash
assistant contacts list --role contact
```

Response shape:

```json
{
  "ok": true,
  "contacts": [
    {
      "id": "uuid",
      "displayName": "Alice",
      "notes": null,
      "lastInteraction": 1700000000000,
      "interactionCount": 12,
      "createdAt": 1699000000000,
      "updatedAt": 1700000000000,
      "role": "contact",
      "channels": [
        {
          "id": "channel-uuid",
          "contactId": "uuid",
          "type": "telegram",
          "address": "alice_handle",
          "isPrimary": true,
          "externalUserId": "123456789",
          "externalChatId": "123456789",
          "status": "active",
          "policy": "allow",
          "verifiedAt": 1699500000000,
          "lastSeenAt": 1700000000000,
          "createdAt": 1699000000000
        }
      ]
    }
  ]
}
```

## 2. Inspect Pending Access Requests

Access requests are stored in the `channel_guardian_approval_requests` table. Use SQLite to inspect pending requests directly.

### Via SQLite CLI

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT id, channel, requester_external_user_id, requester_chat_id, \
   guardian_external_user_id, status, tool_name, created_at, expires_at \
   FROM channel_guardian_approval_requests \
   WHERE tool_name = 'ingress_access_request' AND status = 'pending' \
   ORDER BY created_at DESC;"
```

### Check all access requests (including resolved)

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT id, channel, requester_external_user_id, status, \
   decided_by_external_user_id, created_at \
   FROM channel_guardian_approval_requests \
   WHERE tool_name = 'ingress_access_request' \
   ORDER BY created_at DESC LIMIT 20;"
```

## 3. Inspect Pending Verification Sessions

Verification challenges are stored in `channel_verification_sessions`. Active sessions have `status = 'awaiting_response'` and `expires_at > now`.

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT id, channel, status, identity_binding_status, \
   expected_external_user_id, expected_chat_id, expected_phone_e164, \
   expires_at, created_at \
   FROM channel_verification_sessions \
   WHERE status IN ('awaiting_response', 'pending_bootstrap') \
   AND expires_at > $(date +%s)000 \
   ORDER BY created_at DESC;"
```

## 4. Force-Revoke a Trusted Contact

### Via HTTP API

First, find the contact and its channel ID from the list endpoint, then revoke the channel:

```bash
# Find the contact's channel ID
CHANNEL_ID=$(curl -s "$BASE/v1/contacts?channelType=telegram" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.contacts[] | select(.channels[] | select(.externalUserId == "TARGET_USER_ID")) | .channels[] | select(.externalUserId == "TARGET_USER_ID") | .id')

# Revoke with reason
curl -s -X PATCH "$BASE/v1/contact-channels/$CHANNEL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "revoked", "reason": "Revoked by operator"}' | jq
```

### Block a contact channel (stronger than revoke)

Blocking prevents the contact from re-entering the flow without explicit unblocking.

```bash
curl -s -X PATCH "$BASE/v1/contact-channels/$CHANNEL_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "blocked", "reason": "Blocked by operator"}' | jq
```

### Via SQLite (emergency)

If the HTTP API is unavailable:

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "UPDATE contact_channels \
   SET status = 'revoked', revoked_reason = 'Emergency operator revocation', \
   updated_at = $(date +%s)000 \
   WHERE external_user_id = 'TARGET_USER_ID' AND type = 'telegram';"
```

## 5. Debug Verification Failures

### Check rate limit state

If a user is getting "invalid or expired code" errors, they may be rate-limited:

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT * FROM channel_guardian_rate_limits \
   WHERE external_user_id = 'TARGET_USER_ID' \
   OR chat_id = 'TARGET_CHAT_ID' \
   ORDER BY created_at DESC LIMIT 5;"
```

### Reset rate limits for a user

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "DELETE FROM channel_guardian_rate_limits \
   WHERE external_user_id = 'TARGET_USER_ID' AND channel = 'telegram';"
```

### Check verification challenge state

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT id, channel, status, identity_binding_status, \
   expected_external_user_id, expected_chat_id, expected_phone_e164, \
   expires_at, consumed_by_external_user_id \
   FROM channel_verification_sessions \
   WHERE expected_external_user_id = 'TARGET_USER_ID' \
   OR expected_chat_id = 'TARGET_CHAT_ID' \
   ORDER BY created_at DESC LIMIT 5;"
```

### Common verification failure causes

| Symptom                                                | Likely cause                                                                     | Resolution                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| "Invalid or expired code" (correct code)               | Identity mismatch: the code was entered from a different user/chat than expected | Verify the requester is using the same account that originally requested access                                                            |
| "Invalid or expired code" (correct code, correct user) | Rate-limited (5+ failures in 15 min window)                                      | Wait 30 minutes or reset rate limits via SQLite                                                                                            |
| "Invalid or expired code" (old code)                   | Code TTL expired (10 min)                                                        | Guardian must re-approve to generate a new code                                                                                            |
| Code never delivered to guardian                       | `deliverChannelReply` failed                                                     | Check daemon logs for "Failed to deliver verification code to guardian"                                                                    |
| No notification to guardian                            | No guardian binding for channel                                                  | Verify guardian is bound: check `contacts` table for `role = 'guardian'` with an active `contact_channels` entry matching the channel type |

## 6. Check Notification Delivery Status

### Check if the access request notification was delivered

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT ne.id, ne.source_event_name, ne.dedupe_key, ne.created_at, \
   nd.channel, nd.status, nd.confidence \
   FROM notification_events ne \
   LEFT JOIN notification_decisions nd ON nd.event_id = ne.id \
   WHERE ne.source_event_name LIKE 'ingress.%' \
   ORDER BY ne.created_at DESC LIMIT 20;"
```

### Check delivery records

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT ndel.id, ndel.channel, ndel.status, ndel.error_message, \
   ndel.created_at, ne.source_event_name \
   FROM notification_deliveries ndel \
   JOIN notification_events ne ON ne.id = ndel.event_id \
   WHERE ne.source_event_name LIKE 'ingress.%' \
   ORDER BY ndel.created_at DESC LIMIT 20;"
```

### Check lifecycle signals

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "SELECT source_event_name, source_channel, dedupe_key, created_at \
   FROM notification_events \
   WHERE source_event_name LIKE 'ingress.trusted_contact.%' \
   ORDER BY created_at DESC LIMIT 20;"
```

## 7. Manually Add a Trusted Contact (Bypass Verification)

If the verification flow cannot be completed, an operator can directly create an active contact:

```bash
curl -s -X POST "$BASE/v1/contacts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "displayName": "Alice",
    "role": "contact",
    "channels": [{
      "type": "telegram",
      "address": "alice_handle",
      "externalUserId": "123456789",
      "externalChatId": "123456789",
      "status": "active",
      "policy": "allow"
    }]
  }' | jq
```

For SMS contacts, use the E.164 phone number as the address and external user/chat ID:

```bash
curl -s -X POST "$BASE/v1/contacts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "displayName": "Bob",
    "role": "contact",
    "channels": [{
      "type": "sms",
      "address": "+15551234567",
      "externalUserId": "+15551234567",
      "externalChatId": "+15551234567",
      "status": "active",
      "policy": "allow"
    }]
  }' | jq
```

## 8. Clean Up Expired Data

### Purge expired verification sessions

Expired sessions are already invisible to the verification flow (filtered by `expires_at`), but you can clean them up:

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "DELETE FROM channel_verification_sessions \
   WHERE expires_at < $(date +%s)000 \
   AND status IN ('awaiting_response', 'pending_bootstrap');"
```

### Purge expired approval requests

The `sweepExpiredGuardianApprovals()` timer handles this automatically every 60 seconds, but manual cleanup:

```bash
sqlite3 ~/.vellum/workspace/data/db/assistant.db \
  "UPDATE channel_guardian_approval_requests \
   SET status = 'expired' \
   WHERE status = 'pending' AND expires_at < $(date +%s)000;"
```
