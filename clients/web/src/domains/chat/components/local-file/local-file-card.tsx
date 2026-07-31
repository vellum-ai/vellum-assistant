/**
 * Compact card for a local file the assistant referenced from markdown, used
 * whenever the reference cannot be played inline: a non-media file, a file the
 * daemon cannot serve, or media too large to buffer.
 *
 * Rendered inside a markdown paragraph, so every element is inline-level.
 */

import { ExternalLink, PanelRight, PanelRightClose } from "lucide-react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";

import { cn, Typography } from "@vellumai/design-library";

import {
  formatAttachmentSize,
  middleTruncate,
} from "@/domains/chat/components/chat-attachments/utils";
import { LocalFileIcon } from "@/domains/chat/components/local-file/local-file-icon";
import { LocalFileMenu } from "@/domains/chat/components/local-file/local-file-menu";
import {
  previewKindFor,
  toggleLocalFile,
  useIsWorkspaceFileOpen,
  usesDocumentDrawer,
} from "@/domains/chat/components/local-file/open-local-file";
import type { LocalFileKind } from "@/domains/chat/utils/mime-sniff";

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

/**
 * The click hint keeps its slot in the layout at all times and is only faded
 * in, so revealing it on hover cannot reflow the name or the size beside it.
 * Coarse pointers have no hover, so there it stays visible.
 */
const HINT_REVEAL_CLASSES = [
  "opacity-0 transition-opacity",
  "group-hover/local-file-card:opacity-100",
  "group-focus-visible/local-file-card:opacity-100",
  "[@media(pointer:coarse)]:opacity-100",
].join(" ");

/** What a click does, spelled out so nothing navigates the user by surprise. */
interface ClickHint {
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

/** Where a click lands: away in the workspace, or in one of the drawer's two modes. */
type ClickTarget = "workspace" | "editor" | "preview";

function clickTargetFor(filename: string, assistantId?: string): ClickTarget {
  if (!usesDocumentDrawer(filename, assistantId)) {
    return "workspace";
  }
  return previewKindFor(filename) !== null ? "preview" : "editor";
}

function clickHintFor(target: ClickTarget, isOpen: boolean): ClickHint {
  if (target === "workspace") {
    return { label: "Open in workspace", Icon: ExternalLink };
  }
  if (target === "preview") {
    return isOpen
      ? { label: "Close preview", Icon: PanelRightClose }
      : { label: "Open preview", Icon: PanelRight };
  }
  return isOpen
    ? { label: "Close editor", Icon: PanelRightClose }
    : { label: "Open in editor", Icon: PanelRight };
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
  const clickTarget = clickTargetFor(filename, assistantId);
  const opensDrawer = clickTarget !== "workspace";
  const isOpenInDrawer =
    useIsWorkspaceFileOpen(canOpen ? workspacePath : null) && opensDrawer;
  const secondary = secondaryLineFor(state, displayName, filename);
  const { label: hintLabel, Icon: HintIcon } = clickHintFor(
    clickTarget,
    isOpenInDrawer,
  );
  const actionLabel = isOpenInDrawer
    ? `Close ${clickTarget} for ${filename}`
    : `Open ${filename}`;

  const activate = () => {
    if (canOpen) {
      toggleLocalFile(workspacePath, filename, assistantId);
    }
  };

  return (
    <span
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? actionLabel : undefined}
      aria-expanded={canOpen && opensDrawer ? isOpenInDrawer : undefined}
      title={filename}
      onClick={canOpen ? activate : undefined}
      onKeyDown={
        canOpen
          ? (event: KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate();
              }
            }
          : undefined
      }
      className={cn(
        "group/local-file-card my-2 flex w-full max-w-md items-center gap-2.5 rounded-lg border p-2 transition-colors",
        isOpenInDrawer
          ? "border-[var(--border-active)] bg-[var(--surface-active)]"
          : "border-[var(--border-element)] bg-[var(--surface-lift)]",
        canOpen && "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
          // The open card's surface sits where the sunken tile normally does,
          // so lift the tile instead to keep it readable as a tile.
          isOpenInDrawer
            ? "bg-[var(--surface-lift)]"
            : "bg-[var(--surface-sunken)]",
          isReady
            ? "text-[var(--content-secondary)]"
            : "text-[var(--content-disabled)]",
        )}
      >
        <LocalFileIcon kind={kind} filename={filename} className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Typography
          as="span"
          variant="body-small-default"
          className={cn(
            "truncate",
            isOpenInDrawer
              ? "text-[var(--content-emphasised)]"
              : "text-[var(--content-default)]",
          )}
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
      {canOpen && (
        // Named by the card's own aria-label, so it is decorative here.
        <span
          aria-hidden="true"
          className={cn(
            "flex shrink-0 items-center gap-1",
            isOpenInDrawer
              ? "text-[var(--content-secondary)]"
              : cn(HINT_REVEAL_CLASSES, "text-[var(--content-tertiary)]"),
          )}
        >
          <HintIcon className="h-3.5 w-3.5" />
          <Typography
            as="span"
            variant="label-small-default"
            className="whitespace-nowrap"
          >
            {hintLabel}
          </Typography>
        </span>
      )}
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
