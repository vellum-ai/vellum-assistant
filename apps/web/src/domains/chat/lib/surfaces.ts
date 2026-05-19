/**
 * Surface action submission, content fetching, and artifact download.
 */

import {
  assertHasResponse,
  client,
  extractErrorMessage,
  SDK_BASE_OPTIONS,
} from "@/domains/chat/lib/client.js";

export async function submitSurfaceAction(
  assistantId: string,
  surfaceId: string,
  actionId: string,
  data?: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  if (!surfaceId || typeof surfaceId !== "string" || !actionId || typeof actionId !== "string") {
    return { ok: false };
  }

  try {
    const { error, response } = await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/surface-actions/",
      path: { assistant_id: assistantId },
      body: { surfaceId, actionId, data },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to submit surface action");
    if (!response.ok) {
      return { ok: false };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Surface content re-fetch (matches macOS SurfaceClient.fetchSurfaceContent)
// ---------------------------------------------------------------------------

export interface SurfaceContentResponse {
  surfaceId: string;
  surfaceType: string;
  title?: string | null;
  data: Record<string, unknown>;
}

export async function fetchSurfaceContent(
  assistantId: string,
  surfaceId: string,
  conversationId: string,
): Promise<SurfaceContentResponse | null> {
  try {
    const { data, error, response } = await client.get<SurfaceContentResponse, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/surfaces/{surface_id}",
      path: { assistant_id: assistantId, surface_id: surfaceId },
      query: { conversationId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch surface content");
    if (!response.ok || !data) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Artifact download
// ---------------------------------------------------------------------------

export async function downloadArtifact(
  assistantId: string,
  artifactPath: string,
  filename: string,
): Promise<void> {
  const { data, error, response } = await client.get<Blob | File, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/artifacts/{artifact_path}",
    path: { assistant_id: assistantId, artifact_path: artifactPath },
    parseAs: "blob",
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to download artifact");

  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to download artifact");
    throw new Error(msg);
  }

  if (!(data instanceof Blob)) {
    throw new Error("Failed to download artifact");
  }

  const { saveFile } = await import("@/runtime/native-file.js");
  await saveFile(data, filename);
}
