/**
 * Download a workspace file referenced from chat to the user's device.
 *
 * Fetches the raw bytes from the daemon's workspace content route and hands
 * them to the cross-platform saver (browser download on web, native Share
 * Sheet on iOS/macOS). The workspace domain owns an equivalent helper for its
 * own browser; the chat domain cannot reach across that domain boundary, so
 * chat's file references save through here.
 */

import { workspaceFileContentGet } from "@/generated/daemon/sdk.gen";
import { saveFile } from "@/runtime/native-file";

export async function downloadLocalFile(opts: {
  assistantId: string;
  path: string;
  filename: string;
}): Promise<void> {
  const { data, error } = await workspaceFileContentGet({
    path: { assistant_id: opts.assistantId },
    query: { path: opts.path },
    parseAs: "blob",
    throwOnError: false,
  });

  if (error || !(data instanceof Blob)) {
    throw new Error("Failed to download file");
  }

  await saveFile(data, opts.filename);
}
