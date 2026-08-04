import { workspaceFileContentGet } from "@/generated/daemon/sdk.gen";
import { saveFile } from "@/runtime/native-file";

/**
 * Download a workspace file to the user's device. Fetches the raw bytes from
 * the daemon content endpoint and hands them to the cross-platform saver
 * (browser download on web, native Share Sheet on iOS/macOS).
 *
 * Shared: the workspace browser downloads previewed files through here, and
 * chat's file references do too. It lives at the top level so neither domain
 * has to reach across the other's boundary.
 */
export async function downloadWorkspaceFile(opts: {
  assistantId: string;
  path: string;
  filename: string;
  showHidden?: boolean;
}): Promise<void> {
  const { data, error } = await workspaceFileContentGet({
    path: { assistant_id: opts.assistantId },
    query: {
      path: opts.path,
      ...(opts.showHidden ? { showHidden: "true" } : {}),
    },
    parseAs: "blob",
    throwOnError: false,
  });

  if (error || !(data instanceof Blob)) {
    throw new Error("Failed to download file");
  }

  await saveFile(data, opts.filename);
}
