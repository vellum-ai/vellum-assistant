/**
 * Inline "Thought process" link rendered for a LONE thinking run — a
 * pure-thinking activity group with no adjacent renderable tool call. Unlike
 * the boxed {@link ThinkingBlock} card (used in the flag-off + legacy paths),
 * this is a minimal, container-less affordance rendered through the shared
 * {@link InlineActivityLink}: a brain glyph + label + a trailing chevron that
 * toggles the full reasoning in the shared tool-detail side drawer (the same
 * drawer the in-card thinking pill uses). Clicking the link while its drawer
 * is already open closes it (toggle).
 */

import { Brain } from "lucide-react";

import { InlineActivityLink } from "@/domains/chat/components/inline-activity-link/inline-activity-link";
import { useViewerStore } from "@/stores/viewer-store";

export interface ThoughtProcessLinkProps {
  /** The accumulated reasoning text (markdown), shown in the drawer. */
  content: string;
  /** Whether the reasoning is still streaming in (drives the label). */
  isStreaming?: boolean;
}

export function ThoughtProcessLink({
  content,
  isStreaming = false,
}: ThoughtProcessLinkProps) {
  const toggleToolDetail = useViewerStore.use.toggleToolDetail();
  // When this link's reasoning is the one currently open in the drawer, the
  // label reads as active. Thinking payloads carry an empty `toolCallId`, so
  // we match on the thinking text instead (mirrors the in-card thinking pill).
  const activeDetail = useViewerStore.use.activeToolDetail();
  const isActive =
    activeDetail?.kind === "thinking" && activeDetail.thinkingText === content;

  if (!content) return null;

  return (
    <InlineActivityLink
      data-testid="thought-process-link"
      ariaLabel="View thinking"
      icon={<Brain className="size-4 shrink-0" aria-hidden />}
      label={isStreaming ? "Thinking…" : "Thought process"}
      active={isActive}
      onClick={() =>
        toggleToolDetail({
          kind: "thinking",
          toolCallId: "",
          toolName: "",
          title: "Thought process",
          activity: "",
          input: {},
          status: "completed",
          thinkingText: content,
        })
      }
    />
  );
}
