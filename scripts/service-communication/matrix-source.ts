/**
 * Typed source-of-truth for all assistant/gateway/CES service-to-service
 * communication permutations.
 *
 * Each entry describes a single direction of communication between two
 * services, including the protocol, auth mechanism, and concrete source
 * files that implement the callsite.
 *
 * This file is consumed by `generate-matrix.ts` to render the canonical
 * markdown matrix at `docs/service-communication-matrix.md`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceName = "assistant" | "gateway" | "ces";

export type Protocol =
  | "http"
  | "websocket"
  | "ipc-unix-ndjson"
  | "stdio-ndjson"
  | "unix-socket-ndjson";

export type MatrixEntry = {
  /** Human-readable label for this communication path. */
  label: string;
  /** Service that initiates the communication. */
  caller: ServiceName;
  /** Service that receives the communication. */
  callee: ServiceName;
  /** Wire protocol used. */
  protocol: Protocol;
  /** Auth mechanism (e.g. "JWT Bearer", "CES_SERVICE_TOKEN Bearer", "none"). */
  auth: string;
  /** Description of what this communication path does. */
  description: string;
  /**
   * Glob patterns rooted at the repo root that implement the caller side.
   * Used by the drift guard to detect deleted callsites.
   */
  callerGlobs: string[];
  /**
   * Glob patterns rooted at the repo root that implement the callee side.
   * Used by the drift guard to detect deleted callsites.
   */
  calleeGlobs: string[];
};

// ---------------------------------------------------------------------------
// Matrix entries
// ---------------------------------------------------------------------------

export const MATRIX_ENTRIES: MatrixEntry[] = [
  // =========================================================================
  // Gateway -> Assistant (HTTP)
  // =========================================================================
  {
    label: "Channel inbound forwarding",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (ingress token)",
    description:
      "Gateway forwards normalized channel messages (Telegram, WhatsApp, Slack, email) to the assistant's /v1/channels/inbound endpoint.",
    callerGlobs: ["gateway/src/runtime/client.ts"],
    calleeGlobs: [
      "assistant/src/runtime/routes/inbound-stages/*.ts",
    ],
  },
  {
    label: "Conversation reset",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway resets a channel conversation via DELETE /v1/channels/conversation on the assistant.",
    callerGlobs: ["gateway/src/runtime/client.ts"],
    calleeGlobs: [
      "assistant/src/runtime/routes/inbound-message-handler.ts",
    ],
  },
  {
    label: "Attachment upload",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway uploads channel attachments to the assistant via POST /v1/attachments.",
    callerGlobs: ["gateway/src/runtime/client.ts"],
    calleeGlobs: [
      "assistant/src/runtime/routes/inbound-message-handler.ts",
    ],
  },
  {
    label: "Attachment download",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway downloads attachment metadata and content from the assistant for channel delivery.",
    callerGlobs: ["gateway/src/runtime/client.ts"],
    calleeGlobs: [
      "assistant/src/runtime/routes/inbound-message-handler.ts",
    ],
  },
  {
    label: "Twilio voice webhook forwarding",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway forwards validated Twilio voice/status/connect-action webhooks to the assistant's internal Twilio endpoints.",
    callerGlobs: ["gateway/src/runtime/client.ts"],
    calleeGlobs: ["assistant/src/calls/*.ts"],
  },
  {
    label: "OAuth callback forwarding",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway forwards OAuth callback codes to the assistant's internal OAuth endpoint.",
    callerGlobs: ["gateway/src/runtime/client.ts"],
    calleeGlobs: [
      "assistant/src/runtime/routes/inbound-message-handler.ts",
    ],
  },
  {
    label: "Runtime proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies authenticated external HTTP requests directly to the assistant runtime.",
    callerGlobs: ["gateway/src/http/routes/runtime-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Log export (daemon logs)",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway collects daemon logs from the assistant via POST /v1/export during log export.",
    callerGlobs: ["gateway/src/http/routes/log-export.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Audio proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "none (audioId capability token)",
    description:
      "Gateway proxies Twilio TTS audio fetch requests to the assistant's /v1/audio/:audioId endpoint. The audioId is an unguessable UUID acting as a capability token.",
    callerGlobs: ["gateway/src/http/routes/audio-proxy.ts"],
    calleeGlobs: [
      "assistant/src/runtime/routes/audio-routes.ts",
    ],
  },
  {
    label: "Health probe (migration state)",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway forwards /healthz?include=migrations to the assistant's /v1/health endpoint to surface migration state.",
    callerGlobs: ["gateway/src/index.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Readiness probe",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "none",
    description:
      "Gateway forwards /readyz to the assistant's /readyz endpoint for full-stack readiness checks.",
    callerGlobs: ["gateway/src/index.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },

  {
    label: "Runtime health proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway forwards GET /v1/health to the assistant's runtime health endpoint, exposing it through the gateway even when the broad runtime proxy is disabled.",
    callerGlobs: ["gateway/src/http/routes/runtime-health-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Brain graph proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies GET /v1/brain-graph and GET /v1/brain-graph-ui to the assistant's knowledge-graph visualizer endpoints.",
    callerGlobs: ["gateway/src/http/routes/brain-graph-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Channel readiness proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies /v1/channels/readiness (GET probe and POST refresh) to the assistant's channel readiness control-plane.",
    callerGlobs: ["gateway/src/http/routes/channel-readiness-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Contacts control-plane proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies contacts and invites CRUD (/v1/contacts, /v1/contact-channels, /v1/contacts/invites) to the assistant's ingress contacts control-plane.",
    callerGlobs: ["gateway/src/http/routes/contacts-control-plane-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Migration proxy (export/import)",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies /v1/migrations/export, /v1/migrations/import (sync bytes and async URL-based), and GCS teleport endpoints to the assistant's migration control-plane.",
    callerGlobs: ["gateway/src/http/routes/migration-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Migration rollback proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies POST /v1/admin/rollback-migrations to the assistant's admin migration rollback endpoint.",
    callerGlobs: ["gateway/src/http/routes/migration-rollback-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Workspace commit proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies POST /v1/admin/workspace-commit to the assistant's workspace commit admin endpoint.",
    callerGlobs: ["gateway/src/http/routes/workspace-commit-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Upgrade broadcast proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies POST /v1/admin/upgrade-broadcast to the assistant's upgrade-broadcast admin endpoint.",
    callerGlobs: ["gateway/src/http/routes/upgrade-broadcast-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Pairing proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies /v1/pairing/* (register, request, status) to the assistant's pairing endpoints. The gateway ingress is unauthenticated — secured by a pairingSecret in the request body — while the gateway→assistant hop uses a service token.",
    callerGlobs: ["gateway/src/http/routes/pairing-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Channel integration control-plane proxies",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies Slack, Telegram, Twilio, and Vercel integration control-plane routes (/v1/integrations/*) to the assistant's integration management endpoints.",
    callerGlobs: [
      "gateway/src/http/routes/slack-control-plane-proxy.ts",
      "gateway/src/http/routes/telegram-control-plane-proxy.ts",
      "gateway/src/http/routes/twilio-control-plane-proxy.ts",
      "gateway/src/http/routes/vercel-control-plane-proxy.ts",
    ],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "OAuth control-plane proxies",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies OAuth app/connection management (/v1/oauth/apps, /v1/oauth/connections) and provider discovery (/v1/oauth/providers) to the assistant's OAuth control-plane.",
    callerGlobs: [
      "gateway/src/http/routes/oauth-apps-proxy.ts",
      "gateway/src/http/routes/oauth-providers-proxy.ts",
    ],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Channel verification session proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway proxies channel verification session routes (/v1/channel-verification-sessions) and guardian bootstrap endpoints (/v1/guardian/init, /v1/guardian/refresh) to the assistant. Guardian init enforces a one-time-use bootstrap secret guard before forwarding.",
    callerGlobs: [
      "gateway/src/http/routes/channel-verification-session-proxy.ts",
    ],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },

  // =========================================================================
  // Gateway -> Assistant (WebSocket)
  // =========================================================================
  {
    label: "Twilio ConversationRelay WebSocket proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "websocket",
    auth: "JWT Bearer (service token, query param)",
    description:
      "Gateway proxies Twilio ConversationRelay WebSocket frames to the assistant's /v1/calls/relay endpoint.",
    callerGlobs: [
      "gateway/src/http/routes/twilio-relay-websocket.ts",
    ],
    calleeGlobs: ["assistant/src/calls/relay-server.ts"],
  },
  {
    label: "Browser relay WebSocket proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "websocket",
    auth: "JWT Bearer (service token, query param)",
    description:
      "Gateway proxies Chrome extension browser-relay WebSocket frames to the assistant's /v1/browser-relay endpoint.",
    callerGlobs: [
      "gateway/src/http/routes/browser-relay-websocket.ts",
    ],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Twilio MediaStream WebSocket proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "websocket",
    auth: "JWT Bearer (service token, query param)",
    description:
      "Gateway proxies Twilio MediaStream WebSocket frames to the assistant's /v1/calls/media-stream endpoint.",
    callerGlobs: [
      "gateway/src/http/routes/twilio-media-websocket.ts",
    ],
    calleeGlobs: ["assistant/src/calls/media-stream-server.ts"],
  },
  {
    label: "STT stream WebSocket proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "websocket",
    auth: "JWT Bearer (service token, query param)",
    description:
      "Gateway proxies speech-to-text audio streams to the assistant's /v1/stt/stream WebSocket endpoint.",
    callerGlobs: [
      "gateway/src/http/routes/stt-stream-websocket.ts",
    ],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },

  // =========================================================================
  // Assistant -> Gateway (HTTP)
  // =========================================================================
  {
    label: "Channel reply delivery (Telegram)",
    caller: "assistant",
    callee: "gateway",
    protocol: "http",
    auth: "JWT Bearer (daemon delivery token)",
    description:
      "Assistant delivers reply messages to Telegram chats via the gateway's /deliver/telegram endpoint.",
    callerGlobs: [
      "assistant/src/runtime/gateway-client.ts",
      "assistant/src/notifications/adapters/telegram.ts",
    ],
    calleeGlobs: ["gateway/src/http/routes/telegram-deliver.ts"],
  },
  {
    label: "Channel reply delivery (WhatsApp)",
    caller: "assistant",
    callee: "gateway",
    protocol: "http",
    auth: "JWT Bearer (daemon delivery token)",
    description:
      "Assistant delivers reply messages to WhatsApp via the gateway's /deliver/whatsapp endpoint.",
    callerGlobs: [
      "assistant/src/runtime/gateway-client.ts",
      "assistant/src/messaging/providers/whatsapp/adapter.ts",
    ],
    calleeGlobs: ["gateway/src/http/routes/whatsapp-deliver.ts"],
  },
  {
    label: "Channel reply delivery (Slack)",
    caller: "assistant",
    callee: "gateway",
    protocol: "http",
    auth: "JWT Bearer (daemon delivery token)",
    description:
      "Assistant delivers reply messages to Slack via the gateway's /deliver/slack endpoint.",
    callerGlobs: [
      "assistant/src/runtime/gateway-client.ts",
      "assistant/src/notifications/adapters/slack.ts",
    ],
    calleeGlobs: ["gateway/src/http/routes/slack-deliver.ts"],
  },
  {
    label: "Trust rules CRUD",
    caller: "assistant",
    callee: "gateway",
    protocol: "http",
    auth: "JWT Bearer (edge relay token)",
    description:
      "Assistant reads/writes trust rules via the gateway's /v1/trust-rules REST API (containerized mode).",
    callerGlobs: ["assistant/src/permissions/trust-client.ts"],
    calleeGlobs: [
      "gateway/src/http/routes/trust-rules.ts",
      "gateway/src/trust-store.ts",
    ],
  },

  // =========================================================================
  // Assistant -> Gateway (IPC Unix NDJSON)
  // =========================================================================
  {
    label: "Feature flags IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant fetches merged feature flags from the gateway via the Unix domain socket IPC (get_feature_flags method).",
    callerGlobs: ["assistant/src/ipc/gateway-client.ts"],
    calleeGlobs: [
      "gateway/src/ipc/feature-flag-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Contact data IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant reads contact auth/authz data from the gateway via IPC (get_contact, list_contacts, get_contact_by_channel, get_channels_for_contact).",
    callerGlobs: ["assistant/src/ipc/gateway-client.ts"],
    calleeGlobs: [
      "gateway/src/ipc/contact-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Risk classification IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant classifies tool invocation risk via the persistent IPC connection to the gateway (classify_risk method).",
    callerGlobs: ["assistant/src/ipc/gateway-client.ts"],
    calleeGlobs: [
      "gateway/src/ipc/risk-classification-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Threshold IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant reads auto-approve threshold configuration from the gateway via IPC (get_global_thresholds, get_conversation_threshold methods).",
    callerGlobs: [
      "assistant/src/permissions/gateway-threshold-reader.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/threshold-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },

  // =========================================================================
  // Assistant -> CES (stdio NDJSON — local mode)
  // =========================================================================
  {
    label: "CES RPC (local mode)",
    caller: "assistant",
    callee: "ces",
    protocol: "stdio-ndjson",
    auth: "none (child process)",
    description:
      "Assistant spawns the credential-executor as a child process and communicates via stdio JSON-RPC for tool execution (run_authenticated_command, make_authenticated_request, manage_secure_command_tool).",
    callerGlobs: [
      "assistant/src/credential-execution/process-manager.ts",
      "assistant/src/credential-execution/client.ts",
    ],
    calleeGlobs: [
      "credential-executor/src/server.ts",
      "credential-executor/src/main.ts",
    ],
  },

  // =========================================================================
  // Assistant -> CES (Unix socket NDJSON — managed/Docker mode)
  // =========================================================================
  {
    label: "CES RPC (managed mode)",
    caller: "assistant",
    callee: "ces",
    protocol: "unix-socket-ndjson",
    auth: "none (bootstrap socket)",
    description:
      "Assistant connects to the CES sidecar's bootstrap Unix socket (CES_BOOTSTRAP_SOCKET) for RPC in managed/Docker mode.",
    callerGlobs: [
      "assistant/src/credential-execution/process-manager.ts",
    ],
    calleeGlobs: [
      "credential-executor/src/managed-main.ts",
      "credential-executor/src/server.ts",
    ],
  },

  // =========================================================================
  // Assistant -> CES (HTTP — containerized credential CRUD)
  // =========================================================================
  {
    label: "CES credential CRUD (HTTP)",
    caller: "assistant",
    callee: "ces",
    protocol: "http",
    auth: "CES_SERVICE_TOKEN Bearer",
    description:
      "Assistant performs credential CRUD via the CES HTTP API (CES_CREDENTIAL_URL) in containerized mode.",
    callerGlobs: [
      "assistant/src/security/ces-credential-client.ts",
    ],
    calleeGlobs: [
      "credential-executor/src/http/*.ts",
    ],
  },

  // =========================================================================
  // Gateway -> CES (HTTP — credential reads and log export)
  // =========================================================================
  {
    label: "Gateway credential reads (HTTP)",
    caller: "gateway",
    callee: "ces",
    protocol: "http",
    auth: "CES_SERVICE_TOKEN Bearer",
    description:
      "Gateway reads credentials from the CES HTTP API (CES_CREDENTIAL_URL) in containerized mode for channel auth (Telegram bot token, Twilio SID, etc.).",
    callerGlobs: [
      "gateway/src/credential-reader.ts",
      "gateway/src/credential-watcher.ts",
    ],
    calleeGlobs: [
      "credential-executor/src/http/*.ts",
    ],
  },
  {
    label: "Gateway CES log export (HTTP)",
    caller: "gateway",
    callee: "ces",
    protocol: "http",
    auth: "CES_SERVICE_TOKEN Bearer",
    description:
      "Gateway fetches CES audit logs during log export via GET /v1/logs/export on the CES HTTP API.",
    callerGlobs: ["gateway/src/http/routes/log-export.ts"],
    calleeGlobs: [
      "credential-executor/src/http/*.ts",
    ],
  },
];
