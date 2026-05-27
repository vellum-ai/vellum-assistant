import { client } from "@/generated/api/client.gen";


import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VercelConfigResponse {
  hasToken: boolean;
  success: boolean;
  error?: string;
}

export interface PublishPageResponse {
  success: boolean;
  publicUrl?: string;
  deploymentId?: string;
  error?: string;
  errorCode?: string;
}

export function isCredentialError(result: PublishPageResponse): boolean {
  return (
    result.errorCode === "credentials_missing" ||
    !!result.error?.includes("not allowed to use credential") ||
    !!result.error?.includes("domain restrictions") ||
    !!result.error?.includes("Credential use failed")
  );
}

export interface UnpublishPageResponse {
  success: boolean;
  error?: string;
}

export interface PublishStatusResponse {
  published: boolean;
  publicUrl?: string;
  deploymentId?: string;
  publishedAt?: number;
}

// ---------------------------------------------------------------------------
// SDK base options — same pattern as chat/api.ts
// ---------------------------------------------------------------------------

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Check whether the assistant has a Vercel API token configured.
 *
 * Hits `GET /v1/assistants/{assistant_id}/integrations/vercel/config`.
 */
export async function getVercelConfig(
  assistantId: string,
): Promise<VercelConfigResponse> {
  const { data, error, response } = await client.get<VercelConfigResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/integrations/vercel/config",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to get Vercel config.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to get Vercel config.");
    throw new ApiError(response.status, msg);
  }
  return data as VercelConfigResponse;
}

/**
 * Store a Vercel API token for the assistant.
 *
 * Hits `POST /v1/assistants/{assistant_id}/integrations/vercel/config`
 * with body `{ action: "set", apiToken }`.
 */
export async function setVercelToken(
  assistantId: string,
  apiToken: string,
): Promise<void> {
  const { error, response } = await client.post<{ success: boolean }, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/integrations/vercel/config",
    path: { assistant_id: assistantId },
    headers: { "Content-Type": "application/json" },
    body: { action: "set", apiToken },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to set Vercel token.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to set Vercel token.");
    throw new ApiError(response.status, msg);
  }
}

/**
 * Publish an app to the web via Vercel.
 *
 * Hits `POST /v1/assistants/{assistant_id}/apps/{app_id}/publish`.
 */
export async function publishApp(
  assistantId: string,
  appId: string,
): Promise<PublishPageResponse> {
  const { data, error, response } = await client.post<PublishPageResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/apps/{app_id}/publish",
    path: { assistant_id: assistantId, app_id: appId },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to publish app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to publish app.");
    throw new ApiError(response.status, msg);
  }
  const result = data as PublishPageResponse;

  if (result.success && !result.publicUrl) {
    try {
      const status = await getPublishStatus(assistantId, appId);
      if (status.publicUrl) {
        result.publicUrl = status.publicUrl;
      }
      if (status.deploymentId && !result.deploymentId) {
        result.deploymentId = status.deploymentId;
      }
    } catch {
      // Best-effort — still return the publish result even if status lookup fails
    }
  }

  return result;
}

/**
 * Unpublish an app (remove the Vercel deployment).
 *
 * Hits `POST /v1/assistants/{assistant_id}/apps/{app_id}/unpublish`.
 */
export async function unpublishApp(
  assistantId: string,
  appId: string,
): Promise<UnpublishPageResponse> {
  const { data, error, response } = await client.post<UnpublishPageResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/apps/{app_id}/unpublish",
    path: { assistant_id: assistantId, app_id: appId },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to unpublish app.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to unpublish app.");
    throw new ApiError(response.status, msg);
  }
  return data as UnpublishPageResponse;
}

/**
 * Check the publish status of an app.
 *
 * Hits `GET /v1/assistants/{assistant_id}/apps/{app_id}/publish-status`.
 */
export async function getPublishStatus(
  assistantId: string,
  appId: string,
): Promise<PublishStatusResponse> {
  const { data, error, response } = await client.get<PublishStatusResponse, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/apps/{app_id}/publish-status",
    path: { assistant_id: assistantId, app_id: appId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to get publish status.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to get publish status.");
    throw new ApiError(response.status, msg);
  }
  return data as PublishStatusResponse;
}
