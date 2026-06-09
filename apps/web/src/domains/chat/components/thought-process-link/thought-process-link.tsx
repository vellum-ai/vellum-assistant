/**
 * Inline "Thought process" link rendered for a LONE thinking run — a
 * pure-thinking activity group with no adjacent renderable tool call. Unlike
 * the boxed {@link ThinkingBlock} card (used in the flag-off + legacy paths),
 * this is a minimal, container-less affordance rendered through the shared
 * {@link InlineActivityLink}: a leading glyph + label + a trailing chevron that
 * toggles the full reasoning in the shared tool-detail side drawer (the same
 * drawer the in-card thinking pill uses). Clicking the link while its drawer
 * is already open closes it (toggle).
 *
 * This link OWNS the streaming/loading state too: while reasoning streams in
 * it swaps the brain glyph for our shared {@link ThreeDotIndicator} and reads
 * "Thinking", staying clickable so the live reasoning can be opened in the
 * drawer as it arrives. The standalone transcript "thinking dots" row only
 * covers the window BEFORE an assistant message exists; once reasoning is
 * present this link takes over (see `shouldShowThinkingIndicator`).
 */

import { Brain } from "lucide-react";

import { InlineActivityLink } from "@/domains/chat/components/inline-activity-link/inline-activity-link";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { useViewerStore } from "@/stores/viewer-store";

export interface ThoughtProcessLinkProps {
  /** The accumulated reasoning text (markdown), shown in the drawer. */
  content: string;
  /** Whether the reasoning is still streaming in (drives the glyph + label). */
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

  // While streaming, render even before any reasoning text has landed so this
  // link can be the single thinking affordance from the start of the turn. Once
  // settled, an empty thought process has nothing to show, so collapse it.
  if (!content && !isStreaming) return null;

  return (
    <InlineActivityLink
      data-testid="thought-process-link"
      ariaLabel="View thinking"
      icon={
        isStreaming ? (
          <ThreeDotIndicator
            data-testid="thought-process-loading"
            className="shrink-0"
          />
        ) : (
          <Brain className="size-4 shrink-0" aria-hidden />
        )
      }
      label={isStreaming ? "Thinking" : "Thought process"}
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
