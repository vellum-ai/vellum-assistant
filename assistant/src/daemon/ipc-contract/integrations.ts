// External service integrations: Slack, Telegram, Twilio, Twitter, Vercel, ingress, channel readiness, guardian.

// === Client → Server ===

export interface SlackWebhookConfigRequest {
  type: 'slack_webhook_config';
  action: 'get' | 'set';
  webhookUrl?: string;
}

export interface IngressConfigRequest {
  type: 'ingress_config';
  action: 'get' | 'set';
  publicBaseUrl?: string;
  enabled?: boolean;
}

export interface VercelApiConfigRequest {
  type: 'vercel_api_config';
  action: 'get' | 'set' | 'delete';
  apiToken?: string;
}

export interface TwitterIntegrationConfigRequest {
  type: 'twitter_integration_config';
  action: 'get' | 'set_mode' | 'set_local_client' | 'clear_local_client' | 'disconnect' | 'get_strategy' | 'set_strategy';
  mode?: 'local_byo' | 'managed';
  clientId?: string;
  clientSecret?: string;
  strategy?: string;
}

export interface TelegramConfigRequest {
  type: 'telegram_config';
  action: 'get' | 'set' | 'clear' | 'set_commands';
  botToken?: string;  // Only for action: 'set'
  commands?: Array<{ command: string; description: string }>;  // Only for action: 'set_commands'
}

export interface TwilioConfigRequest {
  type: 'twilio_config';
  action: 'get' | 'set_credentials' | 'clear_credentials' | 'provision_number' | 'assign_number' | 'list_numbers'
    | 'sms_compliance_status' | 'sms_submit_tollfree_verification' | 'sms_update_tollfree_verification'
    | 'sms_delete_tollfree_verification' | 'release_number' | 'sms_send_test' | 'sms_doctor';
  accountSid?: string;        // Only for action: 'set_credentials'
  authToken?: string;         // Only for action: 'set_credentials'
  phoneNumber?: string;       // Only for action: 'assign_number' or 'sms_send_test'
  areaCode?: string;          // Only for action: 'provision_number'
  country?: string;           // Only for action: 'provision_number' (ISO 3166-1 alpha-2, default 'US')
  assistantId?: string;       // Scope number assignment/lookup to a specific assistant
  verificationSid?: string;   // Only for update/delete verification actions
  verificationParams?: {
    tollfreePhoneNumberSid?: string;
    businessName?: string;
    businessWebsite?: string;
    notificationEmail?: string;
    useCaseCategories?: string[];
    useCaseSummary?: string;
    productionMessageSample?: string;
    optInImageUrls?: string[];
    optInType?: string;
    messageVolume?: string;
    businessType?: string;
    customerProfileSid?: string;
  };
  text?: string;              // Only for action: 'sms_send_test' (default: "Test SMS from your Vellum assistant")
}

export interface ChannelReadinessRequest {
  type: 'channel_readiness';
  action: 'get' | 'refresh';
  channel?: string;
  assistantId?: string;
  includeRemote?: boolean;
}

export interface GuardianVerificationRequest {
  type: 'guardian_verification';
  action: 'create_challenge' | 'status' | 'revoke';
  channel?: string;  // Defaults to 'telegram'
  sessionId?: string;
  assistantId?: string;  // Defaults to 'self'
}

export interface TwitterAuthStartRequest {
  type: 'twitter_auth_start';
}

export interface TwitterAuthStatusRequest {
  type: 'twitter_auth_status';
}

export interface IntegrationListRequest {
  type: 'integration_list';
}

export interface IntegrationConnectRequest {
  type: 'integration_connect';
  integrationId: string;
}

export interface IntegrationDisconnectRequest {
  type: 'integration_disconnect';
  integrationId: string;
}

export interface LinkOpenRequest {
  type: 'link_open_request';
  url: string;
  metadata?: Record<string, unknown>;
}

// === Server → Client ===

export interface SlackWebhookConfigResponse {
  type: 'slack_webhook_config_response';
  webhookUrl?: string;
  success: boolean;
  error?: string;
}

export interface IngressConfigResponse {
  type: 'ingress_config_response';
  enabled: boolean;
  publicBaseUrl: string;
  /** Read-only gateway target computed from GATEWAY_PORT env var (default 7830) + loopback host. */
  localGatewayTarget: string;
  success: boolean;
  error?: string;
}

export interface VercelApiConfigResponse {
  type: 'vercel_api_config_response';
  hasToken: boolean;
  success: boolean;
  error?: string;
}

export interface TwitterIntegrationConfigResponse {
  type: 'twitter_integration_config_response';
  success: boolean;
  mode?: 'local_byo' | 'managed';
  managedAvailable: boolean;
  localClientConfigured: boolean;
  connected: boolean;
  accountInfo?: string;
  strategy?: 'oauth' | 'browser' | 'auto';
  /** Whether the user has explicitly set a strategy (vs. relying on the default 'auto'). */
  strategyConfigured?: boolean;
  error?: string;
}

export interface TelegramConfigResponse {
  type: 'telegram_config_response';
  success: boolean;
  hasBotToken: boolean;
  botUsername?: string;
  connected: boolean;
  hasWebhookSecret: boolean;
  lastError?: string;
  error?: string;
}

export interface TwilioConfigResponse {
  type: 'twilio_config_response';
  success: boolean;
  hasCredentials: boolean;
  phoneNumber?: string;
  numbers?: Array<{ phoneNumber: string; friendlyName: string; capabilities: { voice: boolean; sms: boolean } }>;
  error?: string;
  /** Non-fatal warning message (e.g. webhook sync failure that did not prevent the primary operation). */
  warning?: string;
  compliance?: {
    numberType?: string;
    verificationSid?: string;
    verificationStatus?: string;
    rejectionReason?: string;
    rejectionReasons?: string[];
    errorCode?: string;
    editAllowed?: boolean;
    editExpiration?: string;
  };
  /** Present when action is 'sms_send_test'. */
  testResult?: {
    messageSid: string;
    to: string;
    initialStatus: string;
    finalStatus: string;
    errorCode?: string;
    errorMessage?: string;
  };
  /** Present when action is 'sms_doctor'. */
  diagnostics?: {
    readiness: { ready: boolean; issues: string[] };
    compliance: { status: string; detail?: string; remediation?: string };
    lastSend?: { status: string; errorCode?: string; remediation?: string };
    overallStatus: 'healthy' | 'degraded' | 'broken';
    actionItems: string[];
  };
}

export interface ChannelReadinessResponse {
  type: 'channel_readiness_response';
  success: boolean;
  snapshots?: Array<{
    channel: string;
    ready: boolean;
    checkedAt: number;
    stale: boolean;
    reasons: Array<{ code: string; text: string }>;
    localChecks: Array<{ name: string; passed: boolean; message: string }>;
    remoteChecks?: Array<{ name: string; passed: boolean; message: string }>;
  }>;
  error?: string;
}

export interface GuardianVerificationResponse {
  type: 'guardian_verification_response';
  success: boolean;
  secret?: string;
  instruction?: string;
  /** Present when action is 'status'. */
  bound?: boolean;
  guardianExternalUserId?: string;
  /** The channel this status pertains to (e.g. "telegram", "sms"). Present when action is 'status'. */
  channel?: string;
  /** The assistant ID scoped to this status. Present when action is 'status'. */
  assistantId?: string;
  /** The delivery chat ID for the guardian (e.g. Telegram chat ID). Present when action is 'status' and bound is true. */
  guardianDeliveryChatId?: string;
  /** Optional channel username/handle for the bound guardian (for UI display). */
  guardianUsername?: string;
  /** Optional display name for the bound guardian (for UI display). */
  guardianDisplayName?: string;
  error?: string;
}

export interface TwitterAuthResult {
  type: 'twitter_auth_result';
  success: boolean;
  accountInfo?: string;
  error?: string;
}

export interface TwitterAuthStatusResponse {
  type: 'twitter_auth_status_response';
  connected: boolean;
  accountInfo?: string;
  mode?: 'local_byo' | 'managed';
  error?: string;
}

export interface IntegrationListResponse {
  type: 'integration_list_response';
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
  type: 'integration_connect_result';
  integrationId: string;
  success: boolean;
  accountInfo?: string | null;
  error?: string | null;
  setupRequired?: boolean;
  setupSkillId?: string;
  setupHint?: string;
}

export interface OpenUrl {
  type: 'open_url';
  url: string;
  title?: string;
}
