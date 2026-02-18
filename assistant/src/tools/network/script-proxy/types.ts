/** Unique identifier for a proxy session. */
export type ProxySessionId = string;

export type ProxySessionStatus = 'starting' | 'active' | 'stopping' | 'stopped';

export interface ProxySession {
  id: ProxySessionId;
  conversationId: string;
  credentialIds: string[];
  status: ProxySessionStatus;
  createdAt: Date;
  /** Ephemeral port assigned once the session starts listening. */
  port: number | null;
}

export interface ProxySessionConfig {
  /** How long (ms) an idle session stays alive before auto-stopping. */
  idleTimeoutMs: number;
  /** Maximum concurrent sessions per conversation. */
  maxSessionsPerConversation: number;
}

export interface ProxyEnvVars {
  HTTP_PROXY: string;
  HTTPS_PROXY: string;
  NO_PROXY: string;
  SSL_CERT_FILE?: string;
}
