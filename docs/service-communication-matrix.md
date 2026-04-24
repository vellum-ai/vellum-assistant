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
| 4 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Attachment download |
| 5 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Twilio voice webhook forwarding |
| 6 | Gateway -> Assistant | `http` | JWT Bearer (service token) | OAuth callback forwarding |
| 7 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Runtime proxy |
| 8 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Log export (daemon logs) |
| 9 | Gateway -> Assistant | `http` | none (audioId capability token) | Audio proxy |
| 10 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Health probe (migration state) |
| 11 | Gateway -> Assistant | `http` | none | Readiness probe |
| 12 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Runtime health proxy |
| 13 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Brain graph proxy |
| 14 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Channel readiness proxy |
| 15 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Contacts control-plane proxy |
| 16 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Migration proxy (export/import) |
| 17 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Migration rollback proxy |
| 18 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Workspace commit proxy |
| 19 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Upgrade broadcast proxy |
| 20 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Pairing proxy |
| 21 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Channel integration control-plane proxies |
| 22 | Gateway -> Assistant | `http` | JWT Bearer (service token) | OAuth control-plane proxies |
| 23 | Gateway -> Assistant | `http` | JWT Bearer (service token) | Channel verification session proxy |
| 24 | Gateway -> Assistant | `websocket` | JWT Bearer (service token, query param) | Twilio ConversationRelay WebSocket proxy |
| 25 | Gateway -> Assistant | `websocket` | JWT Bearer (service token, query param) | Browser relay WebSocket proxy |
| 26 | Gateway -> Assistant | `websocket` | JWT Bearer (service token, query param) | Twilio MediaStream WebSocket proxy |
| 27 | Gateway -> Assistant | `websocket` | JWT Bearer (service token, query param) | STT stream WebSocket proxy |
| 28 | Assistant -> Gateway | `http` | JWT Bearer (daemon delivery token) | Channel reply delivery (Telegram) |
| 29 | Assistant -> Gateway | `http` | JWT Bearer (daemon delivery token) | Channel reply delivery (WhatsApp) |
| 30 | Assistant -> Gateway | `http` | JWT Bearer (daemon delivery token) | Channel reply delivery (Slack) |
| 31 | Assistant -> Gateway | `http` | JWT Bearer (edge relay token) | Trust rules CRUD |
| 32 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Feature flags IPC |
| 33 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Contact data IPC |
| 34 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Risk classification IPC |
| 35 | Assistant -> Gateway | `ipc-unix-ndjson` | none (local socket) | Threshold IPC |
| 36 | Assistant -> CES | `stdio-ndjson` | none (child process) | CES RPC (local mode) |
| 37 | Assistant -> CES | `unix-socket-ndjson` | none (bootstrap socket) | CES RPC (managed mode) |
| 38 | Assistant -> CES | `http` | CES_SERVICE_TOKEN Bearer | CES credential CRUD (HTTP) |
| 39 | Gateway -> CES | `http` | CES_SERVICE_TOKEN Bearer | Gateway credential reads (HTTP) |
| 40 | Gateway -> CES | `http` | CES_SERVICE_TOKEN Bearer | Gateway CES log export (HTTP) |

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

### Attachment download

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway downloads attachment metadata and content from the assistant for channel delivery.

**Caller files:**
- `gateway/src/runtime/client.ts`

**Callee files:**
- `assistant/src/runtime/routes/inbound-message-handler.ts`

### Twilio voice webhook forwarding

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway forwards validated Twilio voice/status/connect-action webhooks to the assistant's internal Twilio endpoints.

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
- **Description:** Gateway forwards GET /v1/health to the assistant's runtime health endpoint, exposing it through the gateway even when the broad runtime proxy is disabled.

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
- **Description:** Gateway proxies contacts and invites CRUD (/v1/contacts, /v1/contact-channels, /v1/contacts/invites) to the assistant's ingress contacts control-plane.

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

### Pairing proxy

- **Protocol:** `http`
- **Auth:** JWT Bearer (service token)
- **Description:** Gateway proxies /v1/pairing/* (register, request, status) to the assistant's pairing endpoints. The gateway ingress is unauthenticated — secured by a pairingSecret in the request body — while the gateway→assistant hop uses a service token.

**Caller files:**
- `gateway/src/http/routes/pairing-proxy.ts`

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
- **Description:** Gateway proxies channel verification session routes (/v1/channel-verification-sessions) and guardian bootstrap endpoints (/v1/guardian/init, /v1/guardian/refresh) to the assistant. Guardian init enforces a one-time-use bootstrap secret guard before forwarding.

**Caller files:**
- `gateway/src/http/routes/channel-verification-session-proxy.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Twilio ConversationRelay WebSocket proxy

- **Protocol:** `websocket`
- **Auth:** JWT Bearer (service token, query param)
- **Description:** Gateway proxies Twilio ConversationRelay WebSocket frames to the assistant's /v1/calls/relay endpoint.

**Caller files:**
- `gateway/src/http/routes/twilio-relay-websocket.ts`

**Callee files:**
- `assistant/src/calls/relay-server.ts`

### Browser relay WebSocket proxy

- **Protocol:** `websocket`
- **Auth:** JWT Bearer (service token, query param)
- **Description:** Gateway proxies Chrome extension browser-relay WebSocket frames to the assistant's /v1/browser-relay endpoint.

**Caller files:**
- `gateway/src/http/routes/browser-relay-websocket.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

### Twilio MediaStream WebSocket proxy

- **Protocol:** `websocket`
- **Auth:** JWT Bearer (service token, query param)
- **Description:** Gateway proxies Twilio MediaStream WebSocket frames to the assistant's /v1/calls/media-stream endpoint.

**Caller files:**
- `gateway/src/http/routes/twilio-media-websocket.ts`

**Callee files:**
- `assistant/src/calls/media-stream-server.ts`

### STT stream WebSocket proxy

- **Protocol:** `websocket`
- **Auth:** JWT Bearer (service token, query param)
- **Description:** Gateway proxies speech-to-text audio streams to the assistant's /v1/stt/stream WebSocket endpoint.

**Caller files:**
- `gateway/src/http/routes/stt-stream-websocket.ts`

**Callee files:**
- `assistant/src/runtime/http-server.ts`

## Assistant -> Gateway

### Channel reply delivery (Telegram)

- **Protocol:** `http`
- **Auth:** JWT Bearer (daemon delivery token)
- **Description:** Assistant delivers reply messages to Telegram chats via the gateway's /deliver/telegram endpoint.

**Caller files:**
- `assistant/src/runtime/gateway-client.ts`
- `assistant/src/notifications/adapters/telegram.ts`

**Callee files:**
- `gateway/src/http/routes/telegram-deliver.ts`

### Channel reply delivery (WhatsApp)

- **Protocol:** `http`
- **Auth:** JWT Bearer (daemon delivery token)
- **Description:** Assistant delivers reply messages to WhatsApp via the gateway's /deliver/whatsapp endpoint.

**Caller files:**
- `assistant/src/runtime/gateway-client.ts`
- `assistant/src/messaging/providers/whatsapp/adapter.ts`

**Callee files:**
- `gateway/src/http/routes/whatsapp-deliver.ts`

### Channel reply delivery (Slack)

- **Protocol:** `http`
- **Auth:** JWT Bearer (daemon delivery token)
- **Description:** Assistant delivers reply messages to Slack via the gateway's /deliver/slack endpoint.

**Caller files:**
- `assistant/src/runtime/gateway-client.ts`
- `assistant/src/notifications/adapters/slack.ts`

**Callee files:**
- `gateway/src/http/routes/slack-deliver.ts`

### Trust rules CRUD

- **Protocol:** `http`
- **Auth:** JWT Bearer (edge relay token)
- **Description:** Assistant reads/writes trust rules via the gateway's /v1/trust-rules REST API (containerized mode).

**Caller files:**
- `assistant/src/permissions/trust-client.ts`

**Callee files:**
- `gateway/src/http/routes/trust-rules.ts`
- `gateway/src/trust-store.ts`

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
- **Description:** Assistant reads auto-approve threshold configuration from the gateway via IPC (get_global_thresholds, get_conversation_threshold methods).

**Caller files:**
- `assistant/src/permissions/gateway-threshold-reader.ts`

**Callee files:**
- `gateway/src/ipc/threshold-handlers.ts`
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
- **Description:** Assistant connects to the CES sidecar's bootstrap Unix socket (CES_BOOTSTRAP_SOCKET) for RPC in managed/Docker mode.

**Caller files:**
- `assistant/src/credential-execution/process-manager.ts`

**Callee files:**
- `credential-executor/src/managed-main.ts`
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
