/**
 * Turn a file the assistant produced into the props `LocalFileCard` renders.
 *
 * A produced file arrives as a workspace path and a display name, which is
 * less than the card asks for: it also wants the bare filename, the rendering
 * kind, and whether the file can be opened. Deriving that here keeps the
 * classification in one place for every surface that shows an artifact, and
 * keeps the mime rules (owned by the chat domain) out of the surfaces.
 *
 * The size is unknown at this point: the daemon records what a turn attached,
 * not how large it is, and the card renders without one.
 */

import type { LocalFileCardProps } from "@/components/local-file/local-file-card";
import { resolveLocalFileType } from "@/domains/chat/utils/mime-sniff";
import { workspaceBasenameOf } from "@/domains/chat/utils/workspace-path-links";

/** A file an assistant turn attached, as activation progress records it. */
export interface WorkspaceArtifact {
  workspacePath: string;
  displayName: string;
}

export function artifactFileCardProps(
  artifact: WorkspaceArtifact,
  assistantId?: string,
): LocalFileCardProps {
  const filename =
    workspaceBasenameOf(artifact.workspacePath) || artifact.displayName;
  const { kind } = resolveLocalFileType({
    sniffedMime: null,
    serverMime: null,
    filename,
  });
  return {
    displayName: artifact.displayName,
    filename,
    sizeBytes: null,
    kind,
    state: "ready",
    workspacePath: artifact.workspacePath,
    ...(assistantId ? { assistantId } : {}),
  };
}
