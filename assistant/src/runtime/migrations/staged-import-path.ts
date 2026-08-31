/**
 * Resolve a caller-supplied staged-bundle path for local restore.
 *
 * The daemon only opens files that realpath into
 * `${workspaceDir}/.restore-staging/`. Absolute host paths, `..`
 * traversal, and symlink escapes are rejected.
 */

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const RESTORE_STAGING_DIRNAME = ".restore-staging";

export type StagedImportPathErrorCode =
  | "empty"
  | "not_found"
  | "not_file"
  | "symlink"
  | "outside"
  | "extension";

export class StagedImportPathError extends Error {
  public readonly code: StagedImportPathErrorCode;

  constructor(code: StagedImportPathErrorCode, message: string) {
    super(message);
    this.name = "StagedImportPathError";
    this.code = code;
  }
}

/**
 * Resolve `requestedPath` to a regular `.vbundle` file inside the
 * workspace restore-staging directory.
 */
export function resolveStagedImportPath(
  requestedPath: string,
  workspaceDir: string,
): string {
  if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
    throw new StagedImportPathError("empty", "Staged bundle path is empty");
  }
  if (requestedPath.includes("\0")) {
    throw new StagedImportPathError(
      "empty",
      "Staged bundle path is not a valid file path",
    );
  }

  if (!existsSync(workspaceDir)) {
    throw new StagedImportPathError(
      "not_found",
      "Staged bundle file not found",
    );
  }

  const workspaceReal = realpathSync(workspaceDir);
  const stagingRoot = resolve(workspaceReal, RESTORE_STAGING_DIRNAME);
  const candidate = requestedPath.startsWith("/")
    ? resolve(requestedPath)
    : resolve(workspaceReal, requestedPath);

  if (!existsSync(candidate)) {
    throw new StagedImportPathError(
      "not_found",
      "Staged bundle file not found",
    );
  }

  const linkStat = lstatSync(candidate);
  if (linkStat.isSymbolicLink()) {
    throw new StagedImportPathError(
      "symlink",
      "Staged bundle path must not be a symlink",
    );
  }

  const realFile = realpathSync(candidate);
  if (!existsSync(stagingRoot)) {
    throw new StagedImportPathError(
      "outside",
      "Staged bundle path is not inside the restore staging directory",
    );
  }

  const realStaging = realpathSync(stagingRoot);
  const rel = relative(realStaging, realFile);
  if (
    rel === "" ||
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    rel.split(sep).includes("..")
  ) {
    throw new StagedImportPathError(
      "outside",
      "Staged bundle path is not inside the restore staging directory",
    );
  }

  const fileStat = statSync(realFile);
  if (!fileStat.isFile()) {
    throw new StagedImportPathError(
      "not_file",
      "Staged bundle path is not a file",
    );
  }

  if (!realFile.endsWith(".vbundle")) {
    throw new StagedImportPathError(
      "extension",
      "Staged bundle must be a .vbundle file",
    );
  }

  return realFile;
}
