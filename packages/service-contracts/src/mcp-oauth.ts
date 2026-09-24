import { normalizePublicBaseUrl } from "./ingress.js";

export const MCP_OAUTH_CALLBACK_PATH = "/webhooks/oauth/callback";
export const MCP_OAUTH_CLIENT_METADATA_PATH = "/oauth/client-metadata.json";
export const MCP_OAUTH_CLIENT_LOGO_URI = "https://www.vellum.ai/favicon.svg";

export interface McpOAuthClientMetadata {
  client_id?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: ["authorization_code", "refresh_token"];
  response_types: ["code"];
  client_name: string;
  logo_uri: string;
  software_id?: string;
  software_version?: string;
}

export interface BuildMcpOAuthClientMetadataOptions {
  clientId?: string;
  redirectUris: string[];
  clientName?: string;
  softwareId?: string;
  softwareVersion?: string;
}

export function buildMcpOAuthClientMetadata(
  options: BuildMcpOAuthClientMetadataOptions,
): McpOAuthClientMetadata {
  return {
    ...(options.clientId && { client_id: options.clientId }),
    redirect_uris: options.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: options.clientName ?? "Vellum Assistant",
    logo_uri: MCP_OAUTH_CLIENT_LOGO_URI,
    ...(options.softwareId && { software_id: options.softwareId }),
    ...(options.softwareVersion && {
      software_version: options.softwareVersion,
    }),
  };
}

export function buildMcpOAuthCallbackUrl(publicBaseUrl: string): string {
  return `${normalizeBaseUrl(publicBaseUrl)}${MCP_OAUTH_CALLBACK_PATH}`;
}

export function buildMcpOAuthClientMetadataUrl(publicBaseUrl: string): string {
  return `${normalizeBaseUrl(publicBaseUrl)}${MCP_OAUTH_CLIENT_METADATA_PATH}`;
}

function normalizeBaseUrl(publicBaseUrl: string): string {
  const normalized = normalizePublicBaseUrl(publicBaseUrl);
  if (!normalized) {
    throw new Error("MCP OAuth public base URL must not be empty");
  }
  return normalized;
}
