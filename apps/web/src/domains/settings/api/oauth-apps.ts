import {
  buildVellumHeaders,
  buildVellumMutatingHeaders,
} from "@/lib/auth/request-headers";

/** Custom OAuth app stored on the daemon (encrypted on-disk). */
export interface OAuthApp {
  id: string;
  provider_key: string;
  client_id: string;
  created_at: number;
  updated_at: number;
}

/** OAuth connection linked to a custom OAuth app. */
export interface OAuthAppConnection {
  id: string;
  provider_key: string;
  account_info: string | null;
  granted_scopes: string[] | null;
  status: string;
  has_refresh_token: boolean;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface OAuthAppsListResponse {
  apps?: OAuthApp[];
}

interface OAuthAppConnectionsResponse {
  connections?: OAuthAppConnection[];
}

interface OAuthAppConnectResponse {
  auth_url?: string;
  state?: string;
}

interface DaemonErrorBody {
  error?: { message?: string };
  detail?: string;
  message?: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as DaemonErrorBody;
    if (body?.error?.message) {
      return body.error.message;
    }
    if (body?.detail) {
      return body.detail;
    }
    if (body?.message) {
      return body.message;
    }
  } catch {
    // ignore — body was not JSON
  }
  return `${fallback} (HTTP ${res.status})`;
}

/**
 * Custom OAuth app endpoints live on the daemon, reachable from the web app
 * only via the gateway wildcard runtime proxy (`/v1/assistants/<id>/<rest>/`).
 * That proxy is excluded from OpenAPI, so the generated HeyAPI client can't
 * call these routes — hence the hand-written fetch wrappers below.
 */

export async function listOAuthApps(
  assistantId: string,
  providerKey: string,
): Promise<OAuthApp[]> {
  const url = `/v1/assistants/${assistantId}/oauth/apps/?provider_key=${encodeURIComponent(providerKey)}`;
  const res = await fetch(url, { headers: buildVellumHeaders() });
  if (!res.ok) {
    throw new Error(await readError(res, "Failed to load OAuth apps"));
  }
  const data: OAuthAppsListResponse = await res.json();
  return data.apps ?? [];
}

export async function createOAuthApp(
  assistantId: string,
  input: {
    provider_key: string;
    client_id: string;
    client_secret: string;
  },
): Promise<OAuthApp> {
  const url = `/v1/assistants/${assistantId}/oauth/apps/`;
  const res = await fetch(url, {
    method: "POST",
    headers: await buildVellumMutatingHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readError(res, "Failed to create OAuth app"));
  }
  return (await res.json()) as OAuthApp;
}

export async function deleteOAuthApp(
  assistantId: string,
  appId: string,
): Promise<void> {
  const url = `/v1/assistants/${assistantId}/oauth/apps/${appId}/`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: await buildVellumMutatingHeaders(),
  });
  if (!res.ok) {
    throw new Error(await readError(res, "Failed to delete OAuth app"));
  }
}

export async function listOAuthAppConnections(
  assistantId: string,
  appId: string,
): Promise<OAuthAppConnection[]> {
  const url = `/v1/assistants/${assistantId}/oauth/apps/${appId}/connections/`;
  const res = await fetch(url, { headers: buildVellumHeaders() });
  if (!res.ok) {
    throw new Error(
      await readError(res, "Failed to load OAuth app connections"),
    );
  }
  const data: OAuthAppConnectionsResponse = await res.json();
  return data.connections ?? [];
}

export async function deleteOAuthAppConnection(
  assistantId: string,
  connectionId: string,
): Promise<void> {
  const url = `/v1/assistants/${assistantId}/oauth/connections/${connectionId}/`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: await buildVellumMutatingHeaders(),
  });
  if (!res.ok) {
    throw new Error(await readError(res, "Failed to disconnect OAuth account"));
  }
}

export async function startOAuthAppConnect(
  assistantId: string,
  appId: string,
  scopes?: string[],
): Promise<{ authUrl: string; state?: string }> {
  const url = `/v1/assistants/${assistantId}/oauth/apps/${appId}/connect/`;
  const res = await fetch(url, {
    method: "POST",
    headers: await buildVellumMutatingHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({
      callback_transport: "gateway",
      scopes: scopes ?? [],
    }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, "Failed to start OAuth flow"));
  }
  const data: OAuthAppConnectResponse = await res.json();
  if (!data.auth_url) {
    throw new Error("OAuth flow did not return an authorization URL");
  }
  return { authUrl: data.auth_url, state: data.state };
}

/**
 * macOS `maskedClientId` helper: first 12 + "..." + last 4 for long strings,
 * first 8 + "..." for medium strings, raw otherwise.
 */
export function maskClientId(clientId: string): string {
  if (clientId.length > 16) {
    return `${clientId.slice(0, 12)}…${clientId.slice(-4)}`;
  }
  if (clientId.length > 8) {
    return `${clientId.slice(0, 8)}…`;
  }
  return clientId;
}

/** Daemon timestamps are epoch-milliseconds. */
export function formatOAuthTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}
