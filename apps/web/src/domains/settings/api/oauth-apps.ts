import {
  oauthAppsByAppIdConnectionsGet,
  oauthAppsByAppIdConnectPost,
  oauthAppsByIdDelete,
  oauthAppsGet,
  oauthAppsPost,
  oauthConnectionsByIdDelete,
} from "@/generated/daemon/sdk.gen";
import type {
  OauthAppsByAppIdConnectionsGetResponses,
  OauthAppsGetResponses,
} from "@/generated/daemon/types.gen";

/** Custom OAuth app stored on the daemon (encrypted on-disk). */
export type OAuthApp = OauthAppsGetResponses[200]["apps"][number];

/** OAuth connection linked to a custom OAuth app. */
export type OAuthAppConnection =
  OauthAppsByAppIdConnectionsGetResponses[200]["connections"][number];

interface DaemonErrorBody {
  error?: { message?: string };
  detail?: string;
  message?: string;
}

/** Pull a human-readable message out of the daemon SDK's error body. */
function daemonErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const body = error as DaemonErrorBody;
    if (body.error?.message) {
      return body.error.message;
    }
    if (body.detail) {
      return body.detail;
    }
    if (body.message) {
      return body.message;
    }
  }
  return fallback;
}

export async function listOAuthApps(
  assistantId: string,
  providerKey: string,
): Promise<OAuthApp[]> {
  const { data, error } = await oauthAppsGet({
    path: { assistant_id: assistantId },
    query: { provider_key: providerKey },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error(daemonErrorMessage(error, "Failed to load OAuth apps"));
  }
  return data.apps;
}

export async function createOAuthApp(
  assistantId: string,
  input: {
    provider_key: string;
    client_id: string;
    client_secret: string;
  },
): Promise<OAuthApp> {
  const { data, error } = await oauthAppsPost({
    path: { assistant_id: assistantId },
    body: input,
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error(daemonErrorMessage(error, "Failed to create OAuth app"));
  }
  return data.app;
}

export async function deleteOAuthApp(
  assistantId: string,
  appId: string,
): Promise<void> {
  const { error } = await oauthAppsByIdDelete({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: false,
  });
  if (error) {
    throw new Error(daemonErrorMessage(error, "Failed to delete OAuth app"));
  }
}

export async function listOAuthAppConnections(
  assistantId: string,
  appId: string,
): Promise<OAuthAppConnection[]> {
  const { data, error } = await oauthAppsByAppIdConnectionsGet({
    path: { assistant_id: assistantId, appId },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error(
      daemonErrorMessage(error, "Failed to load OAuth app connections"),
    );
  }
  return data.connections;
}

export async function deleteOAuthAppConnection(
  assistantId: string,
  connectionId: string,
): Promise<void> {
  const { error } = await oauthConnectionsByIdDelete({
    path: { assistant_id: assistantId, id: connectionId },
    throwOnError: false,
  });
  if (error) {
    throw new Error(
      daemonErrorMessage(error, "Failed to disconnect OAuth account"),
    );
  }
}

export async function startOAuthAppConnect(
  assistantId: string,
  appId: string,
  scopes?: string[],
): Promise<{ authUrl: string; state?: string }> {
  const { data, error } = await oauthAppsByAppIdConnectPost({
    path: { assistant_id: assistantId, appId },
    body: { callback_transport: "gateway", scopes: scopes ?? [] },
    throwOnError: false,
  });
  if (error || !data) {
    throw new Error(daemonErrorMessage(error, "Failed to start OAuth flow"));
  }
  if (!("auth_url" in data)) {
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
