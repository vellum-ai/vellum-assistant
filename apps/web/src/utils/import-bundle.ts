/**
 * Import a `.vellum` bundle file into the assistant daemon.
 *
 * Sends the raw file bytes as `application/octet-stream`. We use
 * octet-stream (not multipart) because the Django wildcard proxy only
 * forwards `application/octet-stream` as raw binary — multipart is
 * parsed by DRF which drops the file from the forwarded body.
 *
 * The daemon route definition doesn't declare a requestBody, so the
 * generated SDK types have `body?: never`. Uses the raw daemon client
 * for this binary upload.
 */

import { client as daemonClient } from "@/generated/daemon/client.gen";
import type { AppsImportbundlePostResponses } from "@/generated/daemon/types.gen";
import type { ImportBundleResponse } from "@/types/app-types";

export async function importBundle(
  assistantId: string,
  file: File,
): Promise<ImportBundleResponse> {
  const bytes = await file.arrayBuffer();
  const { data, error, response } = await daemonClient.post<
    AppsImportbundlePostResponses,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/apps/import-bundle",
    path: { assistant_id: assistantId },
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
    bodySerializer: (body) => body as ArrayBuffer,
    throwOnError: false,
  });
  if (!response || !response.ok) {
    const msg =
      (error && typeof error === "object" && "message" in error
        ? (error as { message: string }).message
        : null) ?? "Failed to import app.";
    throw new Error(msg);
  }
  return data!;
}
