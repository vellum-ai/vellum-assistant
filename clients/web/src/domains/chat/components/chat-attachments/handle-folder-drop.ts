/**
 * Handles folder drops on the chat composer. Browsers deliver dropped folders
 * as zero-byte `File` objects; the composer's regular upload flow would queue
 * them and never complete. Instead we resolve each folder's native filesystem
 * path (Electron only) and hand it to the composer as a `path-reference`
 * attachment. On web the path isn't available, so the caller surfaces a
 * user-visible error explaining the limitation.
 */

import { getNativePathForFile } from "@/runtime/file-paths";

export interface FolderDropOutcome {
  resolvedPaths: string[];
  /** True when at least one dropped folder could not be resolved to a path. */
  unresolvedCount: number;
}

export const WEB_FOLDER_DROP_ERROR =
  "Folders can't be uploaded directly. Use the desktop app to reference a folder by path, or drop the files inside it.";

/**
 * Attempts to resolve each dropped folder to its native filesystem path via
 * the Electron bridge. Returns the resolved paths plus the count of folders
 * that could not be resolved, letting the caller both queue path references
 * and surface a rejection message when needed.
 */
export function resolveDroppedDirectories(
  directories: File[],
): FolderDropOutcome {
  const resolvedPaths: string[] = [];
  for (const dir of directories) {
    const path = getNativePathForFile(dir);
    if (path) {
      resolvedPaths.push(path);
    }
  }
  return {
    resolvedPaths,
    unresolvedCount: directories.length - resolvedPaths.length,
  };
}
