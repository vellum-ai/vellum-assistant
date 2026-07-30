/**
 * Compact card for a local file the assistant referenced from markdown, used
 * whenever the reference cannot be played inline: a non-media file, a file the
 * daemon cannot serve, or media too large to buffer.
 *
 * Rendered inside a markdown paragraph, so every element is inline-level.
 */

import type { KeyboardEvent, ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import {
  formatAttachmentSize,
  middleTruncate,
} from "@/domains/chat/components/chat-attachments/utils";
import { LocalFileIcon } from "@/domains/chat/components/local-file/local-file-icon";
import { LocalFileMenu } from "@/domains/chat/components/local-file/local-file-menu";
import type { LocalFileKind } from "@/domains/chat/utils/mime-sniff";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

export interface LocalFileCardProps {
  /** Markdown alt/label text, which may equal the filename. */
  displayName: string;
  filename: string;
  sizeBytes: number | null;
  kind: LocalFileKind;
  /** `unavailable` covers outside-workspace references and fetch failures. */
  state: "ready" | "missing" | "unavailable";
  workspacePath: string | null;
  assistantId?: string;
}

function secondaryLineFor(
  state: LocalFileCardProps["state"],
  displayName: string,
  filename: string,
): string | null {
  if (state === "missing") {
    return "File not found";
  }
  if (state === "unavailable") {
    return "File isn't available here";
  }
  return filename !== displayName ? filename : null;
}

export function LocalFileCard({
  displayName,
  filename,
  sizeBytes,
  kind,
  state,
  workspacePath,
  assistantId,
}: LocalFileCardProps): ReactNode {
  const isReady = state === "ready";
  const canOpen = isReady && workspacePath !== null;
  const secondary = secondaryLineFor(state, displayName, filename);

  const open = () => {
    if (canOpen) {
      void openWorkspaceFile(workspacePath);
    }
  };

  return (
    <span
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `Open ${filename}` : undefined}
      title={filename}
      onClick={canOpen ? open : undefined}
      onKeyDown={
        canOpen
          ? (event: KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
              }
            }
          : undefined
      }
      className={`my-2 flex w-full max-w-md items-center gap-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-lift)] p-2${
        canOpen ? " cursor-pointer" : ""
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--surface-sunken)] ${
          isReady
            ? "text-[var(--content-secondary)]"
            : "text-[var(--content-disabled)]"
        }`}
      >
        <LocalFileIcon kind={kind} filename={filename} className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Typography
          as="span"
          variant="body-small-default"
          className="truncate text-[var(--content-default)]"
        >
          {middleTruncate(displayName, 40)}
        </Typography>
        {secondary !== null && (
          <Typography
            as="span"
            variant="label-small-default"
            className="truncate text-[var(--content-tertiary)]"
          >
            {secondary}
          </Typography>
        )}
      </span>
      {sizeBytes !== null && (
        <Typography
          as="span"
          variant="label-small-default"
          className="shrink-0 text-[var(--content-disabled)]"
        >
          {formatAttachmentSize(sizeBytes)}
        </Typography>
      )}
      <LocalFileMenu
        workspacePath={workspacePath}
        filename={filename}
        assistantId={assistantId}
        disabled={!isReady}
      />
    </span>
  );
}
