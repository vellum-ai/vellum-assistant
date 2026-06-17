/**
 * Import a `.vellum` bundle file into the assistant daemon.
 *
 * Sends the raw file bytes as `application/octet-stream`. We use
 * octet-stream (not multipart) because the Django wildcard proxy only
 * forwards `application/octet-stream` as raw binary — multipart is
 * parsed by DRF which drops the file from the forwarded body.
 */

import { appsImportbundlePost } from "@/generated/daemon/sdk.gen";
import type { AppsImportbundlePostResponse } from "@/generated/daemon/types.gen";

export async function importBundle(
  assistantId: string,
  file: File,
): Promise<AppsImportbundlePostResponse> {
  const { data, error, response } = await appsImportbundlePost({
    path: { assistant_id: assistantId },
    body: file,
    // Send the file bytes verbatim with an explicit octet-stream content
    // type; the default JSON serializer would corrupt the binary payload.
    bodySerializer: (body) => body as Blob,
    headers: { "Content-Type": "application/octet-stream" },
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
