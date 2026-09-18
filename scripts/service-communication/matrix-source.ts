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
  | "ipc-unix-framed"
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
    calleeGlobs: ["assistant/src/runtime/routes/inbound-stages/*.ts"],
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
    calleeGlobs: ["assistant/src/runtime/routes/inbound-message-handler.ts"],
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
    calleeGlobs: ["assistant/src/runtime/routes/inbound-message-handler.ts"],
  },
  {
    label: "Twilio voice webhook forwarding",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway forwards validated Twilio voice/status webhooks to the assistant's internal Twilio endpoints.",
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
    calleeGlobs: ["assistant/src/runtime/routes/inbound-message-handler.ts"],
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
    calleeGlobs: ["assistant/src/runtime/routes/audio-routes.ts"],
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
      "Gateway forwards GET /v1/health to the assistant's runtime health endpoint, exposing it through the gateway for dedicated auth handling.",
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
      "Gateway proxies contacts CRUD (/v1/contacts, /v1/contact-channels) to the assistant's ingress contacts control-plane. Invite endpoints (/v1/contacts/invites*) are gateway-native against the gateway DB's ingress_invites table; only the outbound invite-call relay reaches the assistant.",
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
      "Gateway proxies channel verification session routes (/v1/channel-verification-sessions) to the assistant. Guardian endpoints (/v1/guardian/init, /v1/guardian/refresh) are handled gateway-native — they operate directly on the assistant's SQLite database via the shared workspace volume.",
    callerGlobs: [
      "gateway/src/http/routes/channel-verification-session-proxy.ts",
    ],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Desktop setup proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description: "Gateway proxies /v1/desktop/setup to the assistant.",
    callerGlobs: ["gateway/src/http/routes/desktop-setup-proxy.ts"],
    calleeGlobs: ["assistant/src/runtime/routes/desktop-setup-routes.ts"],
  },
  {
    label: "Process status probe",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway's GET /v1/ps calls the assistant's /v1/ps for its process tree and appends the gateway's own entry.",
    callerGlobs: ["gateway/src/http/routes/ps.ts"],
    calleeGlobs: ["assistant/src/runtime/routes/ps-routes.ts"],
  },
  {
    label: "Plugin webhook forwarding",
    caller: "gateway",
    callee: "assistant",
    protocol: "http",
    auth: "JWT Bearer (service token)",
    description:
      "Gateway forwards signature-verified public webhook requests for servable plugin ingress routes to the assistant's /v1/x/plugins/<plugin>/<path>, and posts admission-denied notices to the plugin's notice path.",
    callerGlobs: ["gateway/src/http/routes/plugin-webhook.ts"],
    calleeGlobs: ["assistant/src/runtime/routes/user-routes.ts"],
  },

  // =========================================================================
  // Gateway -> Assistant (WebSocket)
  // =========================================================================
  {
    label: "Twilio MediaStream WebSocket proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "websocket",
    auth: "JWT Bearer (service token, query param)",
    description:
      "Gateway proxies Twilio MediaStream WebSocket frames to the assistant's /v1/calls/media-stream endpoint.",
    callerGlobs: ["gateway/src/http/routes/twilio-media-websocket.ts"],
    calleeGlobs: ["assistant/src/calls/media-stream-server.ts"],
  },
  {
    label: "Audio-stream WebSocket proxies",
    caller: "gateway",
    callee: "assistant",
    protocol: "websocket",
    auth: "JWT Bearer (service token, query param)",
    description:
      "Gateway proxies client audio-stream WebSockets to the assistant's /v1/stt/stream, /v1/watch/stream and /v1/desktop/stream endpoints through one shared gate and frame pump (runtime-audio-stream.ts).",
    callerGlobs: [
      "gateway/src/http/routes/runtime-audio-stream.ts",
      "gateway/src/http/routes/stt-stream-websocket.ts",
      "gateway/src/http/routes/watch-stream-websocket.ts",
      "gateway/src/http/routes/desktop-stream-websocket.ts",
    ],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
  },
  {
    label: "Live voice WebSocket proxy",
    caller: "gateway",
    callee: "assistant",
    protocol: "websocket",
    auth: "JWT Bearer (service token, query param)",
    description:
      "Gateway proxies live voice conversation WebSockets to the assistant's /v1/live-voice endpoint.",
    callerGlobs: ["gateway/src/http/routes/live-voice-websocket.ts"],
    calleeGlobs: ["assistant/src/runtime/http-server.ts"],
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
      "Assistant reads and writes gateway-owned contacts over IPC: rich reads (contacts_list_rich, contacts_get_rich), the mirror reconciler's identity snapshot (contacts_identity_snapshot), the guardian contact (get_guardian_contact), and contact writes relayed to the gateway store (create_contact, update_contact_channel, merge_contacts, upsert_verified_channel, mark_channel_revoked).",
    callerGlobs: [
      "assistant/src/runtime/routes/contact-routes.ts",
      "assistant/src/contacts/gateway-channel-read.ts",
      "assistant/src/contacts/mirror-reconciler.ts",
      "assistant/src/contacts/guardian-contact-reader.ts",
      "assistant/src/contacts/member-write-relay.ts",
      "assistant/src/daemon/handlers/config-channels.ts",
    ],
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
      "Assistant reads auto-approve threshold configuration via gateway IPC (get_global_thresholds, get_conversation_threshold, get_contact_threshold, and resolve_channel_permission_threshold for a channel's permission override). Contact ceiling writes use gateway IPC set_contact_threshold from the gateway contacts CLI, or POST /v1/contacts.",
    callerGlobs: [
      "assistant/src/permissions/gateway-threshold-reader.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/threshold-handlers.ts",
      "gateway/src/ipc/channel-permission-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Channel admission policy IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant reads a channel's admission policy from the gateway (get_channel_admission_policy).",
    callerGlobs: [
      "assistant/src/calls/channel-admission-reader.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/admission-policy-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Inbound trust verdict IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant asks the gateway for the trust verdict on an inbound actor (resolve_inbound_trust).",
    callerGlobs: [
      "assistant/src/calls/inbound-trust-reader.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/trust-verdict-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Guardian delivery IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant resolves where to deliver to the guardian on each channel (resolve_guardian_delivery).",
    callerGlobs: [
      "assistant/src/contacts/guardian-delivery-reader.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/guardian-delivery-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Guardian requests IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant creates, reads, lists, updates, decides and expires gateway-owned guardian requests and their deliveries (the guardian_requests_* methods in GUARDIAN_REQUESTS_IPC_METHODS).",
    callerGlobs: [
      "assistant/src/channels/gateway-guardian-requests.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/guardian-request-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Invites IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant lists, creates, revokes and redeems gateway-owned invites, including voice invites (the invites_* methods in INVITES_IPC_METHODS).",
    callerGlobs: [
      "assistant/src/channels/gateway-invites.ts",
      "assistant/src/calls/gateway-invite-reader.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/invite-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Verification sessions IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant creates and advances gateway-owned channel verification sessions (the methods in VERIFICATION_SESSIONS_IPC_METHODS).",
    callerGlobs: [
      "assistant/src/channels/gateway-verification-sessions.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/verification-session-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Channel socket health IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant reads the health of the gateway's Slack and Discord socket connections (channel_socket_health).",
    callerGlobs: [
      "assistant/src/channels/gateway-channel-socket-health.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/channel-socket-health-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Credential request IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant asks the gateway to create a credential request link (create_credential_request).",
    callerGlobs: [
      "assistant/src/daemon/handlers/shared.ts",
      "assistant/src/runtime/routes/credential-request-routes.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/credential-request-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Gateway log tail IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant tails the gateway's logs for the gateway logs route (gateway_logs_tail).",
    callerGlobs: [
      "assistant/src/runtime/routes/gateway-log-routes.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/log-tail-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Slack thread IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant detaches a conversation from its active Slack thread (detach_slack_active_thread).",
    callerGlobs: [
      "assistant/src/runtime/routes/conversation-cli-routes.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/slack-thread-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Trust rules IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant lists gateway-owned trust rules (trust_rules_list).",
    callerGlobs: [
      "assistant/src/runtime/routes/trust-rules-routes.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/trust-rules-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Velay status IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant reads the Velay tunnel status for the gateway status route (get_velay_status).",
    callerGlobs: [
      "assistant/src/ipc/gateway-client.ts",
      "assistant/src/runtime/routes/gateway-status-routes.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/velay-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },
  {
    label: "Webhook route IPC",
    caller: "assistant",
    callee: "gateway",
    protocol: "ipc-unix-ndjson",
    auth: "none (local socket)",
    description:
      "Assistant registers platform callback webhook routes with the gateway (register_webhook_route).",
    callerGlobs: [
      "assistant/src/ipc/gateway-client.ts",
      "assistant/src/inbound/platform-callback-registration.ts",
    ],
    calleeGlobs: [
      "gateway/src/ipc/webhook-route-handlers.ts",
      "gateway/src/ipc/server.ts",
    ],
  },

  // =========================================================================
  // Gateway -> Assistant (IPC Unix, length-prefixed framing)
  // =========================================================================
  {
    label: "Contacts mirror IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway mirrors its contact writes into the assistant's contact store (contacts_mirror_apply, contacts_mirror_upsert_full, contacts_mirror_upsert_contact, contacts_mirror_upsert_channel, contacts_mirror_merge_contact, contacts_mirror_delete_contact).",
    callerGlobs: [
      "gateway/src/auth/guardian-bootstrap.ts",
      "gateway/src/db/contact-store.ts",
      "gateway/src/http/routes/contact-prompt.ts",
      "gateway/src/http/routes/contacts-control-plane-proxy.ts",
      "gateway/src/verification/contact-helpers.ts",
    ],
    calleeGlobs: [
      "assistant/src/ipc/routes/contacts-mirror-ipc-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Contact info IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway reads assistant-side contact data: batch contact info, channel identity lookups, mirror probes and user-file slugs (contacts-info-client.ts), contact prompt flags (contact_prompt_flags), and the guardian display label (resolve_guardian_label).",
    callerGlobs: [
      "gateway/src/ipc/contacts-info-client.ts",
      "gateway/src/http/routes/contact-prompt.ts",
      "gateway/src/http/routes/contacts-control-plane-proxy.ts",
    ],
    calleeGlobs: [
      "assistant/src/ipc/routes/contacts-info-ipc-routes.ts",
      "assistant/src/runtime/routes/contact-prompt-routes.ts",
      "assistant/src/ipc/routes/guardian-label-ipc-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Invite actions IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway asks the assistant to compose an invite's presentation (invites_compose_presentation), place an invite call (invites_trigger_call), and act on a redeemed invite (invite_redeemed).",
    callerGlobs: [
      "gateway/src/http/routes/contacts-control-plane-proxy.ts",
      "gateway/src/verification/invite-redemption.ts",
    ],
    calleeGlobs: [
      "assistant/src/ipc/routes/invite-ipc-routes.ts",
      "assistant/src/runtime/routes/contact-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Event emission IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway emits client events through the assistant's event hub (emit_event).",
    callerGlobs: [
      "gateway/src/auth/guardian-bootstrap.ts",
      "gateway/src/http/routes/contact-prompt.ts",
      "gateway/src/http/routes/contacts-control-plane-proxy.ts",
      "gateway/src/ipc/threshold-handlers.ts",
    ],
    calleeGlobs: [
      "assistant/src/runtime/routes/events-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Assistant database proxy IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway's one-time data migrations read from and drop tables in the assistant's SQLite database through the assistant (db_proxy). Allowlisted to the migrations; no runtime feature uses it.",
    callerGlobs: [
      "gateway/src/db/assistant-db-proxy.ts",
    ],
    calleeGlobs: [
      "assistant/src/ipc/routes/db-proxy.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Credential write IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway stores a credential submitted through a credential request link (credentials_set).",
    callerGlobs: [
      "gateway/src/http/routes/credential-requests.ts",
    ],
    calleeGlobs: [
      "assistant/src/runtime/routes/credential-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Guardian form IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway claims and resolves a guardian form submitted over HTTP (guardian_form_claim, resolve_guardian_form).",
    callerGlobs: [
      "gateway/src/http/routes/guardian-form-submit.ts",
    ],
    calleeGlobs: [
      "assistant/src/runtime/routes/guardian-form-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Trust rule suggestion IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway asks the assistant to suggest a trust rule (suggest_trust_rule).",
    callerGlobs: [
      "gateway/src/ipc/assistant-client.ts",
    ],
    calleeGlobs: [
      "assistant/src/runtime/routes/suggest-trust-rule-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Runtime route proxy over IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway serves an HTTP request by calling the matching assistant route over IPC when the client sends X-Vellum-Proxy-Server: ipc, using the route schema it caches from get_route_schema.",
    callerGlobs: [
      "gateway/src/http/routes/ipc-runtime-proxy.ts",
      "gateway/src/ipc/route-schema-cache.ts",
    ],
    calleeGlobs: [
      "assistant/src/ipc/routes/route-adapter.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Plugin webhook WebSocket frame IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway terminates plugin ingress WebSockets at the edge and hands each frame, in arrival order, to the plugin's route over IPC as a POST (user_route_post). Nothing travels back to the socket.",
    callerGlobs: [
      "gateway/src/http/routes/plugin-webhook-websocket.ts",
    ],
    calleeGlobs: [
      "assistant/src/runtime/routes/user-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
    ],
  },
  {
    label: "Assistant health IPC",
    caller: "gateway",
    callee: "assistant",
    protocol: "ipc-unix-framed",
    auth: "none (local socket)",
    description:
      "Gateway polls the assistant's health after startup (health).",
    callerGlobs: [
      "gateway/src/post-assistant-ready.ts",
    ],
    calleeGlobs: [
      "assistant/src/runtime/routes/identity-routes.ts",
      "assistant/src/ipc/assistant-server.ts",
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
      "Assistant connects to the CES sidecar's bootstrap Unix socket (CES_BOOTSTRAP_SOCKET_DIR) for RPC in managed/Docker mode.",
    callerGlobs: ["assistant/src/credential-execution/process-manager.ts"],
    calleeGlobs: [
      "credential-executor/src/main.ts",
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
    callerGlobs: ["assistant/src/security/ces-credential-client.ts"],
    calleeGlobs: ["credential-executor/src/http/*.ts"],
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
    calleeGlobs: ["credential-executor/src/http/*.ts"],
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
    calleeGlobs: ["credential-executor/src/http/*.ts"],
  },
];
