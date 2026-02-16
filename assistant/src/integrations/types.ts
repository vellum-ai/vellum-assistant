/**
 * Core type definitions for the integration framework.
 *
 * Integrations connect Vellum to external services (Gmail, Slack, etc.)
 * via OAuth2, API keys, or bearer tokens.
 */

export type IntegrationAuthType = 'oauth2' | 'api_key' | 'token';

export interface OAuth2Config {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  extraParams?: Record<string, string>;
}

export interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  icon?: string;
  authType: IntegrationAuthType;
  oauth2Config?: OAuth2Config;
  credentialFields: string[];
  allowedTools: string[];
  /** Maps OAuth2 scopes to the tools they enable. When present, the effective
   *  allowedTools after OAuth are the union of tools for granted scopes only.
   *  For non-OAuth integrations this is omitted and allowedTools is used as-is. */
  scopeToolMapping?: Record<string, string[]>;
}

export interface IntegrationStatus {
  id: string;
  connected: boolean;
  accountInfo?: string;
  connectedAt?: number;
  lastUsed?: number;
  error?: string;
}

export interface OAuth2TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}
