// External service integrations: Slack, Telegram, Twitter, Vercel, ingress, guardian.

import type { ChannelId } from "../../channels/types.js";

// === Client → Server ===

export interface SlackWebhookConfigRequest {
  type: "slack_webhook_config";
  action: "get" | "set";
  webhookUrl?: string;
}

export interface IngressConfigRequest {
  type: "ingress_config";
  action: "get" | "set";
  publicBaseUrl?: string;
  enabled?: boolean;
}

export interface PlatformConfigRequest {
  type: "platform_config";
  action: "get" | "set";
  baseUrl?: string;
}

export interface VercelApiConfigRequest {
  type: "vercel_api_config";
  action: "get" | "set" | "delete";
  apiToken?: string;
}

export interface TwitterIntegrationConfigRequest {
  type: "twitter_integration_config";
  action:
    | "get"
    | "set_mode"
    | "set_local_client"
    | "clear_local_client"
    | "disconnect"
    | "get_strategy"
    | "set_strategy";
  mode?: "local_byo" | "managed";
  clientId?: string;
  clientSecret?: string;
  strategy?: string;
}

export interface TelegramConfigRequest {
  type: "telegram_config";
  action: "get" | "set" | "clear" | "set_commands" | "setup";
  botToken?: string; // Only for action: 'set' or 'setup'
  commands?: Array<{ command: string; description: string }>; // Only for action: 'set_commands' or 'setup'
}

export interface ChannelVerificationSessionRequest {
  type: "channel_verification_session";
  action:
    | "create_session"
    | "status"
    | "cancel_session"
    | "revoke"
    | "resend_session";
  channel?: ChannelId; // Defaults to 'telegram'
  sessionId?: string;
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

export interface TwitterAuthStartRequest {
  type: "twitter_auth_start";
}

export interface TwitterAuthStatusRequest {
  type: "twitter_auth_status";
}

export interface IntegrationListRequest {
  type: "integration_list";
}

export interface IntegrationConnectRequest {
  type: "integration_connect";
  integrationId: string;
}

export interface IntegrationDisconnectRequest {
  type: "integration_disconnect";
  integrationId: string;
}

export interface OAuthConnectStartRequest {
  type: "oauth_connect_start";
  service: string;
  requestedScopes?: string[];
}

export interface LinkOpenRequest {
  type: "link_open_request";
  url: string;
  metadata?: Record<string, unknown>;
}

// === Server → Client ===

export interface SlackWebhookConfigResponse {
  type: "slack_webhook_config_response";
  webhookUrl?: string;
  success: boolean;
  error?: string;
}

export interface IngressConfigResponse {
  type: "ingress_config_response";
  enabled: boolean;
  publicBaseUrl: string;
  /** Read-only gateway target computed from GATEWAY_PORT env var (default 7830) + loopback host. */
  localGatewayTarget: string;
  success: boolean;
  error?: string;
}

export interface PlatformConfigResponse {
  type: "platform_config_response";
  baseUrl: string;
  success: boolean;
  error?: string;
}

export interface VercelApiConfigResponse {
  type: "vercel_api_config_response";
  hasToken: boolean;
  success: boolean;
  error?: string;
}

export interface TwitterIntegrationConfigResponse {
  type: "twitter_integration_config_response";
  success: boolean;
  mode?: "local_byo" | "managed";
  managedAvailable: boolean;
  localClientConfigured: boolean;
  connected: boolean;
  accountInfo?: string;
  strategy?: "oauth" | "browser" | "auto";
  /** Whether the user has explicitly set a strategy (vs. relying on the default 'auto'). */
  strategyConfigured?: boolean;
  error?: string;
}

export interface TelegramConfigResponse {
  type: "telegram_config_response";
  success: boolean;
  hasBotToken: boolean;
  botUsername?: string;
  connected: boolean;
  hasWebhookSecret: boolean;
  lastError?: string;
  error?: string;
  /** Names of bot commands that were registered (present after set_commands or setup). */
  commandsRegistered?: string[];
  /** Non-fatal warning (e.g. commands registration failed during setup but token was configured). */
  warning?: string;
}

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
  /** Session ID for outbound verification flows. */
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

export interface TwitterAuthResult {
  type: "twitter_auth_result";
  success: boolean;
  accountInfo?: string;
  error?: string;
}

export interface TwitterAuthStatusResponse {
  type: "twitter_auth_status_response";
  connected: boolean;
  accountInfo?: string;
  mode?: "local_byo" | "managed";
  error?: string;
}

export interface IntegrationListResponse {
  type: "integration_list_response";
  integrations: Array<{
    id: string;
    connected: boolean;
    accountInfo?: string | null;
    connectedAt?: number | null;
    lastUsed?: number | null;
    error?: string | null;
  }>;
}

export interface IntegrationConnectResult {
  type: "integration_connect_result";
  integrationId: string;
  success: boolean;
  accountInfo?: string | null;
  error?: string | null;
  setupRequired?: boolean;
  setupSkillId?: string;
  setupHint?: string;
}

export interface OAuthConnectResultResponse {
  type: "oauth_connect_result";
  success: boolean;
  grantedScopes?: string[];
  accountInfo?: string;
  error?: string;
}

export interface OpenUrl {
  type: "open_url";
  url: string;
  title?: string;
}

export interface NavigateSettings {
  type: "navigate_settings";
  tab: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _IntegrationsClientMessages =
  | SlackWebhookConfigRequest
  | IngressConfigRequest
  | PlatformConfigRequest
  | VercelApiConfigRequest
  | TwitterIntegrationConfigRequest
  | TelegramConfigRequest
  | ChannelVerificationSessionRequest
  | TwitterAuthStartRequest
  | TwitterAuthStatusRequest
  | IntegrationListRequest
  | IntegrationConnectRequest
  | IntegrationDisconnectRequest
  | OAuthConnectStartRequest
  | LinkOpenRequest;

export type _IntegrationsServerMessages =
  | SlackWebhookConfigResponse
  | IngressConfigResponse
  | PlatformConfigResponse
  | VercelApiConfigResponse
  | TwitterIntegrationConfigResponse
  | TelegramConfigResponse
  | ChannelVerificationSessionResponse
  | TwitterAuthResult
  | TwitterAuthStatusResponse
  | IntegrationListResponse
  | IntegrationConnectResult
  | OAuthConnectResultResponse
  | OpenUrl
  | NavigateSettings;
