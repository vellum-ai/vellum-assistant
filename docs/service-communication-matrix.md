# Service Communication Matrix

> **Auto-generated** from `scripts/service-communication/matrix-source.ts`.
> Do not edit by hand. Run `bun run scripts/service-communication/generate-matrix.ts` to regenerate.

This document enumerates every observed communication permutation between the three core services:
**Assistant** (daemon), **Gateway** (channel ingress), and **CES** (Credential Execution Service).

## Summary

| # | Direction | Protocol | Auth | Label |
|---|-----------|----------|------|-------|
| 1 | Gateway -> Assistant | `http` | JWT Bearer (ingress token) | Channel inbound forwarding |
| 2 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Conversation reset |
| 3 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Attachment upload |
| 4 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Twilio voice webhook forwarding |
| 5 | Gateway -> Assistant | `http` | JWT Bearer (service token) | OAuth callback forwarding |
| 6 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Runtime proxy |
| 7 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Log export (daemon logs) |
| 8 | Gateway -> Assistant | `http` | none (audioId capability token) | Audio proxy |
| 9 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Health probe (migration state) |
| 10 | Gateway -> Assistant | `http` | none | Readiness probe |
| 11 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Runtime health proxy |
| 12 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Brain graph proxy |
| 13 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Channel readiness proxy |
| 14 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Contacts control-plane proxy |
| 15 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Migration proxy (export/import) |
| 16 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Migration rollback proxy |
| 17 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Workspace commit proxy |
| 18 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Upgrade broadcast proxy |
| 19 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Channel integration control-plane proxies |
| 20 | Gateway -> Assistant | `http` | JWT Bearer (service token) | OAuth control-plane proxies |
| 21 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Channel verification session proxy |
| 22 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Desktop setup proxy |
| 23 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Process status probe |
| 24 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Plugin webhook forwarding |
| 25 | Gateway -> Assistant | `websocket` | JWT Bearer (service token, query param) | Twilio MediaStream WebSocket proxy |
| 26 | Gateway -> Assistant | `websocket` | JWT Bearer (service token, query param) | Audio-stream WebSocket proxies |
| 27 | Gateway -> Assistant | `websocket` | JWT Bearer (service token, query param) | Live voice WebSocket proxy |
| 28 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Feature flags IPC |
| 29 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Contact data IPC |
| 30 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Risk classification IPC |
| 31 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Threshold IPC |
| 32 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Channel admission policy IPC |
| 33 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Inbound trust verdict IPC |
| 34 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Guardian delivery IPC |
| 35 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Guardian requests IPC |
| 36 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Invites IPC |
| 37 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Verification sessions IPC |
| 38 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Channel socket health IPC |
| 39 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Credential request IPC |
| 40 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Gateway log tail IPC |
| 41 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Slack thread IPC |
| 42 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Trust rules IPC |
| 43 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Velay status IPC |
| 44 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Webhook route IPC |
| 45 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Contacts mirror IPC |
| 46 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Contact info IPC |
| 47 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Invite actions IPC |
| 48 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Event emission IPC |
| 49 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Assistant database proxy IPC |
| 50 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Credential write IPC |
| 51 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Guardian form IPC |
| 52 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Trust rule suggestion IPC |
| 53 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Runtime route proxy over IPC |
| 54 | Gateway -> Assistant | `ipc-unix-framed` | none (local socket) | Assistant health IPC |
| 55 | Assistant -> CES | `stdio-ndjson` | none (child process) | CES RPC (local mode) |
| 56 | Assistant -> CES | `unix-socket-ndjson` | none (bootstrap socket) | CES RPC (managed mode) |
| 57 | Assistant -> CES | `http` | CES_SERVICE_TOKEN Bearer | CES credential CRUD (HTTP) |
| 58 | Gateway -> CES | `http` | CES_SERVICE_TOKEN Bearer | Gateway credential reads (HTTP) |
| 59 | Gateway -> CES | `http` | CES_SERVICE_TOKEN Bearer | Gateway CES log export (HTTP) |

## Gateway -> Assistant

### Channel inbound forwarding

- **Protocol:** `http`
- **Auth:** JWT Bearer (ingress token)
- **Description:** Gateway forwards normalized channel messages (Telegram, WhatsApp, Slack, email) to the assistant's /v1/channels/inbound endpoint.

**Caller files:**
- `gateway/src/runtime/client.ts`

**Callee files:**
- `assistant/src/runtime/routes/inbound-stages/*.ts`

### Conversation reset

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway resets a channel conversation via DELETE /v1/channels/conversation on the assistant.

**Caller files:**
- `gateway/src/runtime/client.ts`

**Callee files:**
- `assistant/src/runtime/routes/inbound-message-handler.ts`

### Attachment upload

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway uploads channel attachments to the assistant via POST /v1/attachments.

**Caller files:**
- `gateway/src/runtime/client.ts`

**Callee files:**
- `assistant/src/runtime/routes/inbound-message-handler.ts`

### Twilio voice webhook forwarding

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway forwards validated Twilio voice/status webhooks to the assistant's internal Twilio endpoints.

**Caller files:**
- `gateway/src/runtime/client.ts`

**Callee files:**
- `assistant/src/calls/*.ts`

### OAuth callback forwarding

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway forwards OAuth callback codes to the assistant's internal OAuth endpoint.

**Caller files:**
- `gateway/src/runtime/client.ts`

**Callee files:**
- `assistant/src/runtime/routes/inbound-message-handler.ts`

### Runtime proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies authenticated external HTTP requests directly to the assistant runtime.

**Caller files:**
- `gateway/src/http/routes/runtime-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Log export (daemon logs)

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway collects daemon logs from the assistant via POST /v1/export during log export.

**Caller files:**
- `gateway/src/http/routes/log-export.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Audio proxy

- **Protocol:** `http`
- **Auth:** none (audioId capability token)
- **Description:** Gateway proxies Twilio TTS audio fetch requests to the assistant's /v1/audio/:audioId endpoint. The audioId is an unguessable UUID acting as a capability token.

**Caller files:**
- `gateway/src/http/routes/audio-proxy.ts`

**Callee files:**
- `assistant/src/runtime/routes/audio-routes.ts`

### Health probe (migration state)

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway forwards /healthz?include=migrations to the assistant's /v1/health endpoint to surface migration state.

**Caller files:**
- `gateway/src/index.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Readiness probe

- **Protocol:** `http`
- **Auth:** none
- **Description:** Gateway forwards /readyz to the assistant's /readyz endpoint for full-stack readiness checks.

**Caller files:**
- `gateway/src/index.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Runtime health proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway forwards GET /v1/health to the assistant's runtime health endpoint, exposing it through the gateway for dedicated auth handling.

**Caller files:**
- `gateway/src/http/routes/runtime-health-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Brain graph proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies GET /v1/brain-graph and GET /v1/brain-graph-ui to the assistant's knowledge-graph visualizer endpoints.

**Caller files:**
- `gateway/src/http/routes/brain-graph-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Channel readiness proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies /v1/channels/readiness (GET probe and POST refresh) to the assistant's channel readiness control-plane.

**Caller files:**
- `gateway/src/http/routes/channel-readiness-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Contacts control-plane proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies contacts CRUD (/v1/contacts, /v1/contact-channels) to the assistant's ingress contacts control-plane. Invite endpoints (/v1/contacts/invites*) are gateway-native against the gateway DB's ingress_invites table; only the outbound invite-call relay reaches the assistant.

**Caller files:**
- `gateway/src/http/routes/contacts-control-plane-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Migration proxy (export/import)

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies /v1/migrations/export, /v1/migrations/import (sync bytes and async URL-based), and GCS teleport endpoints to the assistant's migration control-plane.

**Caller files:**
- `gateway/src/http/routes/migration-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Migration rollback proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies POST /v1/admin/rollback-migrations to the assistant's admin migration rollback endpoint.

**Caller files:**
- `gateway/src/http/routes/migration-rollback-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Workspace commit proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies POST /v1/admin/workspace-commit to the assistant's workspace commit admin endpoint.

**Caller files:**
- `gateway/src/http/routes/workspace-commit-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Upgrade broadcast proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies POST /v1/admin/upgrade-broadcast to the assistant's upgrade-broadcast admin endpoint.

**Caller files:**
- `gateway/src/http/routes/upgrade-broadcast-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Channel integration control-plane proxies

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies Slack, Telegram, Twilio, and Vercel integration control-plane routes (/v1/integrations/*) to the assistant's integration management endpoints.

**Caller files:**
- `gateway/src/http/routes/slack-control-plane-proxy.ts`
- `gateway/src/http/routes/telegram-control-plane-proxy.ts`
- `gateway/src/http/routes/twilio-control-plane-proxy.ts`
- `gateway/src/http/routes/vercel-control-plane-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### OAuth control-plane proxies

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies OAuth app/connection management (/v1/oauth/apps, /v1/oauth/connections) and provider discovery (/v1/oauth/providers) to the assistant's OAuth control-plane.

**Caller files:**
- `gateway/src/http/routes/oauth-apps-proxy.ts`
- `gateway/src/http/routes/oauth-providers-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Channel verification session proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies channel verification session routes (/v1/channel-verification-sessions) to the assistant. Guardian endpoints (/v1/guardian/init, /v1/guardian/refresh) are handled gateway-native — they operate directly on the assistant's SQLite database via the shared workspace volume.

**Caller files:**
- `gateway/src/http/routes/channel-verification-session-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Desktop setup proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies /v1/desktop/setup to the assistant.

**Caller files:**
- `gateway/src/http/routes/desktop-setup-proxy.ts`

**Callee files:**
- `assistant/src/runtime/routes/desktop-setup-routes.ts`

### Process status probe

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway's GET /v1/ps calls the assistant's /v1/ps for its process tree and appends the gateway's own entry.

**Caller files:**
- `gateway/src/http/routes/ps.ts`

**Callee files:**
- `assistant/src/runtime/routes/ps-routes.ts`

### Plugin webhook forwarding

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway forwards signature-verified public webhook requests for servable plugin ingress routes to the assistant's /v1/x/plugins/<plugin>/<path>, and posts admission-denied notices to the plugin's notice path.

**Caller files:**
- `gateway/src/http/routes/plugin-webhook.ts`

**Callee files:**
- `assistant/src/runtime/routes/user-routes.ts`

### Twilio MediaStream WebSocket proxy

- **Protocol:** `websocket`
- **Auth:** JWT Bearer (service token, query param)
- **Description:** Gateway proxies Twilio MediaStream WebSocket frames to the assistant's /v1/calls/media-stream endpoint.

**Caller files:**
- `gateway/src/http/routes/twilio-media-websocket.ts`

**Callee files:**
- `assistant/src/calls/media-stream-server.ts`

### Audio-stream WebSocket proxies

- **Protocol:** `websocket`
- **Auth:** JWT Bearer (service token, query param)
- **Description:** Gateway proxies client audio-stream WebSockets to the assistant's /v1/stt/stream, /v1/watch/stream and /v1/desktop/stream endpoints through one shared gate and frame pump (runtime-audio-stream.ts).

**Caller files:**
- `gateway/src/http/routes/runtime-audio-stream.ts`
- `gateway/src/http/routes/stt-stream-websocket.ts`
- `gateway/src/http/routes/watch-stream-websocket.ts`
- `gateway/src/http/routes/desktop-stream-websocket.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Live voice WebSocket proxy

- **Protocol:** `websocket`
- **Auth:** JWT Bearer (service token, query param)
- **Description:** Gateway proxies live voice conversation WebSockets to the assistant's /v1/live-voice endpoint.

**Caller files:**
- `gateway/src/http/routes/live-voice-websocket.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Contacts mirror IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway mirrors its contact writes into the assistant's contact store (contacts_mirror_apply, contacts_mirror_upsert_full, contacts_mirror_upsert_contact, contacts_mirror_upsert_channel, contacts_mirror_merge_contact, contacts_mirror_delete_contact).

**Caller files:**
- `gateway/src/auth/guardian-bootstrap.ts`
- `gateway/src/db/contact-store.ts`
- `gateway/src/http/routes/contact-prompt.ts`
- `gateway/src/http/routes/contacts-control-plane-proxy.ts`
- `gateway/src/verification/contact-helpers.ts`

**Callee files:**
- `assistant/src/ipc/routes/contacts-mirror-ipc-routes.ts`
- `assistant/src/ipc/assistant-server.ts`

### Contact info IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway reads assistant-side contact data: batch contact info, channel identity lookups, mirror probes and user-file slugs (contacts-info-client.ts), contact prompt flags (contact_prompt_flags), and the guardian display label (resolve_guardian_label).

**Caller files:**
- `gateway/src/ipc/contacts-info-client.ts`
- `gateway/src/http/routes/contact-prompt.ts`
- `gateway/src/http/routes/contacts-control-plane-proxy.ts`

**Callee files:**
- `assistant/src/ipc/routes/contacts-info-ipc-routes.ts`
- `assistant/src/runtime/routes/contact-prompt-routes.ts`
- `assistant/src/ipc/routes/guardian-label-ipc-routes.ts`
- `assistant/src/ipc/assistant-server.ts`

### Invite actions IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway asks the assistant to compose an invite's presentation (invites_compose_presentation), place an invite call (invites_trigger_call), and act on a redeemed invite (invite_redeemed).

**Caller files:**
- `gateway/src/http/routes/contacts-control-plane-proxy.ts`
- `gateway/src/verification/invite-redemption.ts`

**Callee files:**
- `assistant/src/ipc/routes/invite-ipc-routes.ts`
- `assistant/src/runtime/routes/contact-routes.ts`
- `assistant/src/ipc/assistant-server.ts`

### Event emission IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway emits client events through the assistant's event hub (emit_event).

**Caller files:**
- `gateway/src/auth/guardian-bootstrap.ts`
- `gateway/src/http/routes/contact-prompt.ts`
- `gateway/src/http/routes/contacts-control-plane-proxy.ts`
- `gateway/src/ipc/threshold-handlers.ts`

**Callee files:**
- `assistant/src/runtime/routes/events-routes.ts`
- `assistant/src/ipc/assistant-server.ts`

### Assistant database proxy IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway's one-time data migrations read from and drop tables in the assistant's SQLite database through the assistant (db_proxy). Allowlisted to the migrations; no runtime feature uses it.

**Caller files:**
- `gateway/src/db/assistant-db-proxy.ts`

**Callee files:**
- `assistant/src/ipc/routes/db-proxy.ts`
- `assistant/src/ipc/assistant-server.ts`

### Credential write IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway stores a credential submitted through a credential request link (credentials_set).

**Caller files:**
- `gateway/src/http/routes/credential-requests.ts`

**Callee files:**
- `assistant/src/runtime/routes/credential-routes.ts`
- `assistant/src/ipc/assistant-server.ts`

### Guardian form IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway claims and resolves a guardian form submitted over HTTP (guardian_form_claim, resolve_guardian_form).

**Caller files:**
- `gateway/src/http/routes/guardian-form-submit.ts`

**Callee files:**
- `assistant/src/runtime/routes/guardian-form-routes.ts`
- `assistant/src/ipc/assistant-server.ts`

### Trust rule suggestion IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway asks the assistant to suggest a trust rule (suggest_trust_rule).

**Caller files:**
- `gateway/src/ipc/assistant-client.ts`

**Callee files:**
- `assistant/src/runtime/routes/suggest-trust-rule-routes.ts`
- `assistant/src/ipc/assistant-server.ts`

### Runtime route proxy over IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway serves an HTTP request by calling the matching assistant route over IPC when the client sends X-Vellum-Proxy-Server: ipc, using the route schema it caches from get_route_schema.

**Caller files:**
- `gateway/src/http/routes/ipc-runtime-proxy.ts`
- `gateway/src/ipc/route-schema-cache.ts`

**Callee files:**
- `assistant/src/ipc/routes/route-adapter.ts`
- `assistant/src/ipc/assistant-server.ts`

### Assistant health IPC

- **Protocol:** `ipc-unix-framed`
- **Auth:** none (local socket)
- **Description:** Gateway polls the assistant's health after startup (health).

**Caller files:**
- `gateway/src/post-assistant-ready.ts`

**Callee files:**
- `assistant/src/runtime/routes/identity-routes.ts`
- `assistant/src/ipc/assistant-server.ts`

## Assistant -> Gateway

### Feature flags IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant fetches merged feature flags from the gateway via the Unix domain socket IPC (get_feature_flags method).

**Caller files:**
- `assistant/src/ipc/gateway-client.ts`

**Callee files:**
- `gateway/src/ipc/feature-flag-handlers.ts`
- `gateway/src/ipc/server.ts`

### Contact data IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant reads contact auth/authz data from the gateway via IPC (get_contact, list_contacts, get_contact_by_channel, get_channels_for_contact).

**Caller files:**
- `assistant/src/ipc/gateway-client.ts`

**Callee files:**
- `gateway/src/ipc/contact-handlers.ts`
- `gateway/src/ipc/server.ts`

### Risk classification IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant classifies tool invocation risk via the persistent IPC connection to the gateway (classify_risk method).

**Caller files:**
- `assistant/src/ipc/gateway-client.ts`

**Callee files:**
- `gateway/src/ipc/risk-classification-handlers.ts`
- `gateway/src/ipc/server.ts`

### Threshold IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant reads auto-approve threshold configuration via gateway IPC (get_global_thresholds, get_conversation_threshold, get_contact_threshold, and resolve_channel_permission_threshold for a channel's permission override). Contact ceiling writes use gateway IPC set_contact_threshold from the gateway contacts CLI, or POST /v1/contacts.

**Caller files:**
- `assistant/src/permissions/gateway-threshold-reader.ts`

**Callee files:**
- `gateway/src/ipc/threshold-handlers.ts`
- `gateway/src/ipc/channel-permission-handlers.ts`
- `gateway/src/ipc/server.ts`

### Channel admission policy IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant reads a channel's admission policy from the gateway (get_channel_admission_policy).

**Caller files:**
- `assistant/src/calls/channel-admission-reader.ts`

**Callee files:**
- `gateway/src/ipc/admission-policy-handlers.ts`
- `gateway/src/ipc/server.ts`

### Inbound trust verdict IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant asks the gateway for the trust verdict on an inbound actor (resolve_inbound_trust).

**Caller files:**
- `assistant/src/calls/inbound-trust-reader.ts`

**Callee files:**
- `gateway/src/ipc/trust-verdict-handlers.ts`
- `gateway/src/ipc/server.ts`

### Guardian delivery IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant resolves where to deliver to the guardian on each channel (resolve_guardian_delivery).

**Caller files:**
- `assistant/src/contacts/guardian-delivery-reader.ts`

**Callee files:**
- `gateway/src/ipc/guardian-delivery-handlers.ts`
- `gateway/src/ipc/server.ts`

### Guardian requests IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant creates, reads, lists, updates, decides and expires gateway-owned guardian requests and their deliveries (the guardian_requests_* methods in GUARDIAN_REQUESTS_IPC_METHODS).

**Caller files:**
- `assistant/src/channels/gateway-guardian-requests.ts`

**Callee files:**
- `gateway/src/ipc/guardian-request-handlers.ts`
- `gateway/src/ipc/server.ts`

### Invites IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant lists, creates, revokes and redeems gateway-owned invites, including voice invites (the invites_* methods in INVITES_IPC_METHODS).

**Caller files:**
- `assistant/src/channels/gateway-invites.ts`
- `assistant/src/calls/gateway-invite-reader.ts`

**Callee files:**
- `gateway/src/ipc/invite-handlers.ts`
- `gateway/src/ipc/server.ts`

### Verification sessions IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant creates and advances gateway-owned channel verification sessions (the methods in VERIFICATION_SESSIONS_IPC_METHODS).

**Caller files:**
- `assistant/src/channels/gateway-verification-sessions.ts`

**Callee files:**
- `gateway/src/ipc/verification-session-handlers.ts`
- `gateway/src/ipc/server.ts`

### Channel socket health IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant reads the health of the gateway's Slack and Discord socket connections (channel_socket_health).

**Caller files:**
- `assistant/src/channels/gateway-channel-socket-health.ts`

**Callee files:**
- `gateway/src/ipc/channel-socket-health-handlers.ts`
- `gateway/src/ipc/server.ts`

### Credential request IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant asks the gateway to create a credential request link (create_credential_request).

**Caller files:**
- `assistant/src/daemon/handlers/shared.ts`
- `assistant/src/runtime/routes/credential-request-routes.ts`

**Callee files:**
- `gateway/src/ipc/credential-request-handlers.ts`
- `gateway/src/ipc/server.ts`

### Gateway log tail IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant tails the gateway's logs for the gateway logs route (gateway_logs_tail).

**Caller files:**
- `assistant/src/runtime/routes/gateway-log-routes.ts`

**Callee files:**
- `gateway/src/ipc/log-tail-handlers.ts`
- `gateway/src/ipc/server.ts`

### Slack thread IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant detaches a conversation from its active Slack thread (detach_slack_active_thread).

**Caller files:**
- `assistant/src/runtime/routes/conversation-cli-routes.ts`

**Callee files:**
- `gateway/src/ipc/slack-thread-handlers.ts`
- `gateway/src/ipc/server.ts`

### Trust rules IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant lists gateway-owned trust rules (trust_rules_list).

**Caller files:**
- `assistant/src/runtime/routes/trust-rules-routes.ts`

**Callee files:**
- `gateway/src/ipc/trust-rules-handlers.ts`
- `gateway/src/ipc/server.ts`

### Velay status IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant reads the Velay tunnel status for the gateway status route (get_velay_status).

**Caller files:**
- `assistant/src/ipc/gateway-client.ts`
- `assistant/src/runtime/routes/gateway-status-routes.ts`

**Callee files:**
- `gateway/src/ipc/velay-handlers.ts`
- `gateway/src/ipc/server.ts`

### Webhook route IPC

- **Protocol:** `ipc-unix-ndjson`
- **Auth:** none (local socket)
- **Description:** Assistant registers platform callback webhook routes with the gateway (register_webhook_route).

**Caller files:**
- `assistant/src/ipc/gateway-client.ts`
- `assistant/src/inbound/platform-callback-registration.ts`

**Callee files:**
- `gateway/src/ipc/webhook-route-handlers.ts`
- `gateway/src/ipc/server.ts`

## Assistant -> CES

### CES RPC (local mode)

- **Protocol:** `stdio-ndjson`
- **Auth:** none (child process)
- **Description:** Assistant spawns the credential-executor as a child process and communicates via stdio JSON-RPC for tool execution (run_authenticated_command, make_authenticated_request, manage_secure_command_tool).

**Caller files:**
- `assistant/src/credential-execution/process-manager.ts`
- `assistant/src/credential-execution/client.ts`

**Callee files:**
- `credential-executor/src/server.ts`
- `credential-executor/src/main.ts`

### CES RPC (managed mode)

- **Protocol:** `unix-socket-ndjson`
- **Auth:** none (bootstrap socket)
- **Description:** Assistant connects to the CES sidecar's bootstrap Unix socket (CES_BOOTSTRAP_SOCKET_DIR) for RPC in managed/Docker mode.

**Caller files:**
- `assistant/src/credential-execution/process-manager.ts`

**Callee files:**
- `credential-executor/src/main.ts`
- `credential-executor/src/server.ts`

### CES credential CRUD (HTTP)

- **Protocol:** `http`
- **Auth:** CES_SERVICE_TOKEN Bearer
- **Description:** Assistant performs credential CRUD via the CES HTTP API (CES_CREDENTIAL_URL) in containerized mode.

**Caller files:**
- `assistant/src/security/ces-credential-client.ts`

**Callee files:**
- `credential-executor/src/http/*.ts`

## Gateway -> CES

### Gateway credential reads (HTTP)

- **Protocol:** `http`
- **Auth:** CES_SERVICE_TOKEN Bearer
- **Description:** Gateway reads credentials from the CES HTTP API (CES_CREDENTIAL_URL) in containerized mode for channel auth (Telegram bot token, Twilio SID, etc.).

**Caller files:**
- `gateway/src/credential-reader.ts`
- `gateway/src/credential-watcher.ts`

**Callee files:**
- `credential-executor/src/http/*.ts`

### Gateway CES log export (HTTP)

- **Protocol:** `http`
- **Auth:** CES_SERVICE_TOKEN Bearer
- **Description:** Gateway fetches CES audit logs during log export via GET /v1/logs/export on the CES HTTP API.

**Caller files:**
- `gateway/src/http/routes/log-export.ts`

**Callee files:**
- `credential-executor/src/http/*.ts`
