/**
 * Renders a code span that `rehypeWorkspacePath` flagged as a workspace file
 * path, upgrading it to a file link only once the file is confirmed to exist.
 *
 * Existence is the whole point of the component. A path-shaped code span is
 * not evidence of a file: the assistant writes paths it is *about* to create
 * ("I'll save it to `/workspace/drafts/notes.md`"), paths it has since
 * deleted, and hypothetical examples. Linking optimistically would produce a
 * dead affordance in exactly those cases, so the link appears only after a
 * directory listing shows a matching file. Until then — and on any miss or
 * error — the span renders as ordinary inline code, which is the pre-existing
 * behavior.
 *
 * The check is a `workspace/tree` listing of the file's parent directory
 * rather than a per-file fetch: `workspace/file` returns the file's full
 * inline text, which is a lot of payload to decide whether to underline
 * something. TanStack Query dedupes by key, so N paths in one directory —
 * the common case in a "here's what I wrote" message — cost one request, and
 * the listing is shared with any other consumer already browsing that
 * directory. Because the query lives in the cache, a file that appears later
 * lights its link up on the next refetch without the message re-rendering
 * from scratch.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { MARKDOWN_INLINE_CODE_CLASS } from "@vellumai/design-library";
import { workspaceTreeGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  toVellumWorkspaceHref,
  workspaceBasenameOf,
  workspaceDirOf,
} from "@/domains/chat/utils/workspace-path-links";

/**
 * Workspace contents change while a conversation is open (the assistant is
 * often writing the very file being discussed), so listings are refetched
 * more eagerly than a static browse would need.
 */
const LISTING_STALE_MS = 15_000;

export interface WorkspacePathLinkProps {
  /** Workspace-relative path, set by `rehypeWorkspacePath`. */
  path?: string;
  /** The path exactly as the assistant wrote it — what the span displays. */
  raw?: string;
  /** Active assistant whose workspace the path is resolved against. */
  assistantId?: string | null;
  /**
   * Click handler shared with `vellum://` markdown links, so a resolved path
   * opens the same file-action modal (Go to file / Download) as an explicitly
   * linked file. Without it there is no affordance to offer and the span stays
   * plain code.
   */
  onOpen?: (href: string, linkText: string) => void;
}

export function WorkspacePathLink({
  path,
  raw,
  assistantId,
  onOpen,
}: WorkspacePathLinkProps) {
  const label = raw ?? path ?? "";
  const enabled = Boolean(path && assistantId && onOpen);

  const { data } = useQuery({
    ...workspaceTreeGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { path: path ? workspaceDirOf(path) : "" },
    }),
    enabled,
    staleTime: LISTING_STALE_MS,
    // A path the assistant invented names a directory that often doesn't
    // exist; retrying a 404 three times per span would turn a speculative
    // match into real traffic.
    retry: false,
  });

  const exists = useMemo(
    () =>
      path != null &&
      (data?.entries.some(
        (entry) => entry.type === "file" && entry.path === path,
      ) ??
        false),
    [data, path],
  );

  if (!exists || !path || !onOpen) {
    return <code className={MARKDOWN_INLINE_CODE_CLASS}>{label}</code>;
  }

  return (
    <button
      type="button"
      onClick={() =>
        onOpen(toVellumWorkspaceHref(path), workspaceBasenameOf(path))
      }
      className={`${MARKDOWN_INLINE_CODE_CLASS} cursor-pointer text-[var(--system-positive-strong)] underline decoration-dotted underline-offset-2 hover:opacity-80`}
      title={`Open ${path}`}
    >
      {label}
    </button>
  );
}
