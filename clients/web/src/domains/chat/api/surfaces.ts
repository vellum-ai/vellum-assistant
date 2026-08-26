/**
 * Surface action submission, content fetching, and document PDF download.
 */

import {
  documentsByIdPdfGet,
  surfaceactionsPost,
  surfacesBySurfaceIdGet,
} from "@/generated/daemon/sdk.gen";
import type {
  SurfaceactionsPostResponse,
  SurfacesBySurfaceIdGetResponse,
} from "@/generated/daemon/types.gen";

export type SurfaceActionResult =
  | { ok: false }
  | {
      ok: true;
      applied?: boolean;
      reason?: string;
      replyText?: string;
      /**
       * The resolved outcome action for a guardian decision (apr:*) — not
       * necessarily the raw button (an access-request `reject` resolves to the
       * `leave_unverified` park). Used to render the correct completion tone
       * when the card is completed optimistically.
       */
      decidedAction?: string;
    };

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
      ...(body.decidedAction ? { decidedAction: body.decidedAction } : {}),
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
// Document PDF download
// ---------------------------------------------------------------------------

/**
 * Fetch a document surface's PDF export and hand it to `saveFile`, which
 * owns per-host transport and outcome feedback. Throws on a failed fetch so
 * each caller can surface its own error state.
 */
export async function downloadDocumentPdf(
  assistantId: string,
  surfaceId: string,
  title: string | null | undefined,
): Promise<void> {
  const { data: blob, response } = await documentsByIdPdfGet({
    path: { assistant_id: assistantId, id: surfaceId },
    throwOnError: false,
    parseAs: "blob",
  });
  if (!response?.ok || !(blob instanceof Blob)) {
    throw new Error("Failed to export document PDF");
  }
  const { saveFile } = await import("@/runtime/native-file");
  await saveFile(blob, `${title || "document"}.pdf`);
}
