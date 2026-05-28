/**
 * Export an app as a downloadable `.vellum` bundle.
 *
 * 1. Calls the share-cloud endpoint to package the app server-side.
 * 2. Downloads the binary bundle using the returned share token.
 * 3. Saves/shares the file via the cross-platform saveFile helper.
 */

import {
  appsByIdSharecloudPost,
  appsSharedByTokenGet,
} from "@/generated/daemon/sdk.gen";
import { saveFile } from "@/runtime/native-file";

export async function shareApp(
  assistantId: string,
  appId: string,
  appName: string,
): Promise<void> {
  const { data } = await appsByIdSharecloudPost({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: true,
  });
  if (!data.shareToken) {
    throw new Error("Share response missing token.");
  }

  const { response: dlResponse } = await appsSharedByTokenGet({
    path: { assistant_id: assistantId, token: data.shareToken },
    throwOnError: false,
    parseAs: "stream",
  });
  if (!dlResponse || !dlResponse.ok) {
    throw new Error("Failed to download app bundle.");
  }
  const blob = await dlResponse.blob();

  const safeName = appName.replace(/[/\\:*?"<>|]/g, "_").trim() || "App";
  await saveFile(blob, `${safeName}.vellum`);
}
