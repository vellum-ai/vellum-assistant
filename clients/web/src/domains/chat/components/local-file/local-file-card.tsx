/**
 * Compact card for a local file the assistant referenced from markdown, used
 * whenever the reference cannot be played inline: a non-media file, a file the
 * daemon cannot serve, or media too large to buffer.
 *
 * Rendered inside a markdown paragraph, so every element is inline-level.
 */

import { ExternalLink, PanelRight } from "lucide-react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";

import { cn, Typography } from "@vellumai/design-library";

import {
  formatAttachmentSize,
  middleTruncate,
} from "@/domains/chat/components/chat-attachments/utils";
import { LocalFileIcon } from "@/domains/chat/components/local-file/local-file-icon";
import { LocalFileMenu } from "@/domains/chat/components/local-file/local-file-menu";
import {
  localFileDestination,
  toggleLocalFile,
  useIsWorkspaceFileOpen,
  type LocalFileDestination,
} from "@/domains/chat/components/local-file/open-local-file";
import type { LocalFileKind } from "@/domains/chat/utils/mime-sniff";
import { useConversationStore } from "@/stores/conversation-store";

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
type ClickMode = LocalFileDestination["mode"];

function clickHintFor(mode: ClickMode): ClickHint {
  if (mode === "workspace") {
    return { label: "Open in workspace", Icon: ExternalLink };
  }
  if (mode === "preview") {
    return { label: "Open preview", Icon: PanelRight };
  }
  return { label: "Open in editor", Icon: PanelRight };
}

/** How the card names the mode in its close label. */
const CLOSE_LABELS: Record<ClickMode, string> = {
  workspace: "workspace",
  document: "editor",
  preview: "preview",
};

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
  // Markdown opens as a document bound to the conversation it was opened from,
  // so the active conversation decides where a click on it lands.
  const conversationId = useConversationStore.use.activeConversationId();
  const isReady = state === "ready";
  const canOpen = isReady && workspacePath !== null;
  const { mode } = localFileDestination(filename, assistantId, conversationId);
  const opensDrawer = mode !== "workspace";
  const isOpenInDrawer =
    useIsWorkspaceFileOpen(canOpen ? workspacePath : null) && opensDrawer;
  const secondary = secondaryLineFor(state, displayName, filename);
  const { label: hintLabel, Icon: HintIcon } = clickHintFor(mode);
  const actionLabel = isOpenInDrawer
    ? `Close ${CLOSE_LABELS[mode]} for ${filename}`
    : `Open ${filename}`;

  const activate = () => {
    if (canOpen) {
      toggleLocalFile(workspacePath, filename, assistantId, conversationId);
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
      {/* An open card relies on its highlighted state alone; the hint only
          previews what a click will do before the drawer is open. */}
      {canOpen && !isOpenInDrawer && (
        // Named by the card's own aria-label, so it is decorative here.
        <span
          aria-hidden="true"
          className={cn(
            "flex shrink-0 items-center gap-1",
            HINT_REVEAL_CLASSES,
            "text-[var(--content-tertiary)]",
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
