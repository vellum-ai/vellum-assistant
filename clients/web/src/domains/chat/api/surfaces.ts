/**
 * Surface action submission, content fetching, and artifact download.
 */

import { client } from "@/generated/api/client.gen";
import {
  surfaceactionsPost,
  surfacesBySurfaceIdGet,
} from "@/generated/daemon/sdk.gen";
import type {
  SurfaceactionsPostResponse,
  SurfacesBySurfaceIdGetResponse,
} from "@/generated/daemon/types.gen";
import { assertHasResponse, extractErrorMessage } from "@/utils/api-errors";

export type SurfaceActionResult =
  | { ok: false }
  | { ok: true; applied?: boolean; reason?: string; replyText?: string };

export async function submitSurfaceAction(
  assistantId: string,
  surfaceId: string,
  actionId: string,
  data?: Record<string, unknown>,
  conversationId?: string,
): Promise<SurfaceActionResult> {
  if (
    !surfaceId ||
    typeof surfaceId !== "string" ||
    !actionId ||
    typeof actionId !== "string"
  ) {
    return { ok: false };
  }

  try {
    const { data: resData, response } = await surfaceactionsPost({
      path: { assistant_id: assistantId },
      body: { surfaceId, actionId, data, conversationId },
      throwOnError: false,
    });
    if (!response?.ok || !resData) {
      return { ok: false };
    }
    const body = resData as SurfaceactionsPostResponse;
    return {
      ok: true,
      ...(typeof body.applied === "boolean" ? { applied: body.applied } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.replyText ? { replyText: body.replyText } : {}),
    };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Surface content re-fetch (matches macOS SurfaceClient.fetchSurfaceContent)
// ---------------------------------------------------------------------------

export async function fetchSurfaceContent(
  assistantId: string,
  surfaceId: string,
  conversationId: string,
): Promise<SurfacesBySurfaceIdGetResponse | null> {
  try {
    const { data, response } = await surfacesBySurfaceIdGet({
      path: { assistant_id: assistantId, surfaceId },
      query: { conversationId },
      throwOnError: false,
    });
    if (!response?.ok || !data) {
      return null;
    }
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
    url: "/v1/assistants/{assistant_id}/artifacts/{artifact_path}",
    path: { assistant_id: assistantId, artifact_path: artifactPath },
    parseAs: "blob",
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to download artifact");

  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to download artifact",
    );
    throw new Error(msg);
  }

  if (!(data instanceof Blob)) {
    throw new Error("Failed to download artifact");
  }

  const { saveFile } = await import("@/runtime/native-file");
  await saveFile(data, filename);
}
