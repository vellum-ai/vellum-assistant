// External service integrations: Slack, Telegram, Vercel, ingress, platform.
//
// Server→client events that are live hub broadcasts are single-sourced from
// their canonical `api/events` wire schemas; this file only composes them into
// the domain union consumed by `message-protocol.ts`. Config get/set flows
// (Slack webhook, ingress, platform, Vercel, Telegram, integration listing and
// connect) are served by the HTTP settings routes, not by client messages.

import type { NavigateSettingsEvent } from "../../api/events/navigate-settings.js";
import type { OAuthConnectResultEvent } from "../../api/events/oauth-connect-result.js";
import type { OpenPanelEvent } from "../../api/events/open-panel.js";
import type { OpenUrlEvent } from "../../api/events/open-url.js";
import type { PlatformDisconnectedEvent } from "../../api/events/platform-disconnected.js";
import type { ShowPlatformLoginEvent } from "../../api/events/show-platform-login.js";
import type { ChannelId } from "../../channels/types.js";

// === Client → Server ===

export interface ChannelVerificationSessionRequest {
  type: "channel_verification_session";
  action:
    | "create_session"
    | "status"
    | "cancel_session"
    | "revoke"
    | "resend_session";
  channel?: ChannelId; // Defaults to 'telegram'
  conversationId?: string;
  rebind?: boolean; // When true, allows creating a challenge even if a binding already exists
  /** E.164 phone number for phone, Telegram handle/chat-id. Used by outbound actions. */
  destination?: string;
  /** Origin conversation ID so completion/failure pointers can route back. */
  originConversationId?: string;
  /** Distinguishes guardian vs trusted-contact verification flows in the unified create endpoint. */
  purpose?: "guardian" | "trusted_contact";
  /** Contact-channel ID for the absorbed contact-channel verify flow. */
  contactChannelId?: string;
}

// === Server → Client ===

export interface ChannelVerificationSessionResponse {
  type: "channel_verification_session_response";
  success: boolean;
  secret?: string;
  instruction?: string;
  /** Present when action is 'status'. */
  bound?: boolean;
  guardianExternalUserId?: string;
  /** The channel this status pertains to (e.g. "telegram", "phone"). Present when action is 'status'. */
  channel?: ChannelId;
  /** The assistant ID scoped to this status. Present when action is 'status'. */
  assistantId?: string;
  /** The delivery chat ID for the guardian (e.g. Telegram chat ID). Present when action is 'status' and bound is true. */
  guardianDeliveryChatId?: string;
  /** Optional channel username/handle for the bound guardian (for UI display). */
  guardianUsername?: string;
  /** Optional display name for the bound guardian (for UI display). */
  guardianDisplayName?: string;
  /** Whether a pending verification challenge exists for this (assistantId, channel). Used by relay setup to detect active voice verification sessions. */
  hasPendingChallenge?: boolean;
  error?: string;
  /** Human-readable error detail (e.g. for already_bound failures). */
  message?: string;
  /** Conversation ID for outbound verification flows. */
  verificationSessionId?: string;
  /** Epoch ms when the verification session expires. */
  expiresAt?: number;
  /** Epoch ms after which a resend is allowed. */
  nextResendAt?: number;
  /** Number of sends for this session. */
  sendCount?: number;
  /** Telegram deep-link URL for bootstrap (M3 placeholder). */
  telegramBootstrapUrl?: string;
  /** True when the outbound session is still in pending_bootstrap state (Telegram handle flow). Prevents the client from clearing the bootstrap URL during status polling. */
  pendingBootstrap?: boolean;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _IntegrationsClientMessages = ChannelVerificationSessionRequest;

export type _IntegrationsServerMessages =
  | ChannelVerificationSessionResponse
  | OAuthConnectResultEvent
  | OpenUrlEvent
  | OpenPanelEvent
  | NavigateSettingsEvent
  | ShowPlatformLoginEvent
  | PlatformDisconnectedEvent;
