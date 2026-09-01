/**
 * The chat's ambient status controls: Progress and Agents.
 *
 * Two bare pills, each opening its own panel (a popover on a pointer device, a
 * bottom sheet on a touch phone, via {@link AdaptivePopover}). Neither carries a
 * label: they sit together in one cluster, and at that size a word apiece
 * turned a glanceable row into a sentence. Each self-sources and self-hides, so
 * this only decides placement.
 *
 * Assets is deliberately NOT here. It belongs to the conversation as a whole
 * rather than to a moment in it, and it lives in the header cluster where it
 * always has.
 *
 * Placement follows the space actually available, not the platform:
 *
 *  - **Floating in the right gutter**, when the chat column is wide enough that
 *    the centred transcript leaves an empty strip beside it. Mounted INSIDE the
 *    chat column rather than as a column of its own, which is what keeps the
 *    controls out of the drawers' way: the document viewer, subagent, and tool
 *    detail panels all open to the RIGHT of the chat (see
 *    `AnimatedRightDrawer`), so a rail out there would be a second thing
 *    competing for that edge.
 *  - **In the composer's own settings row** otherwise, on the left, beside
 *    Relaxed and Balanced: on a phone, which has no gutter at any width, and on
 *    a desktop column whose gutter has closed because a drawer opened, the
 *    window narrowed, or the sidebar widened. Sharing that row rather than
 *    floating above it means one strip of controls over the composer instead of
 *    two, and the pills set the height these match. Floating controls
 *    would start covering the messages they annotate, so they move to the one
 *    strip that is always free, right above the input where the cursor already
 *    is. See {@link SideControlPlacementBoundary}, which measures the column
 *    rather than guessing from a breakpoint, because the same window is wide or
 *    narrow depending on what else is open beside the chat.
 *
 * See `docs/PLATFORM_ADAPTATION.md` on branching by window size vs. by space.
 */

import { useLocation } from "react-router";
import type { CSSProperties } from "react";

import { ProgressAgentsCard } from "@/domains/chat/components/progress-agents-card";
import { ProgressCard } from "@/domains/chat/components/progress-card";
import { useSideControlsFitGutterValue } from "@/domains/chat/components/side-control-placement";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isPopoutWindow } from "@/runtime/popout-window";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

export interface ProgressStackProps {
  /**
   * Which of the two mount points this is. Both mount unconditionally and each
   * self-gates on the shared measurement, so exactly one ever draws.
   *
   * Two mounts rather than one, because they are different positions in the
   * tree and not different CSS: `column` floats over the top of the chat
   * column, `composer` sits in flow inside the composer's own column, where it
   * can never overlap the input.
   */
  placement: "column" | "composer";
}

export function ProgressStack({ placement }: ProgressStackProps) {
  const { t } = useTranslation("chat");
  const isMobile = useIsMobile();
  const location = useLocation();
  const conversationId = useConversationStore.use.activeConversationId();

  // Measured once by the column boundary and read by both mounts, so the two
  // can never disagree and draw the cluster twice or not at all.
  const fitsGutter = useSideControlsFitGutterValue();

  // A pop-out has no header and carries every process kind in its own
  // `ActiveProcessOverlay` row (see `POPOUT_OVERLAY_PROCESS_KINDS`), so a
  // cluster here would report the same subagents and ACP runs a second time.
  if (isPopoutWindow(location.search)) {
    return null;
  }

  // The gutter is a desktop affordance that also needs the room for it;
  // everything else falls to the composer row. Hooks above run either way.
  const floats = !isMobile && fitsGutter;
  if (placement === "column" ? !floats : floats) {
    return null;
  }

  const controls = (
    <>
      <ProgressCard />
      {conversationId ? (
        <ProgressAgentsCard conversationId={conversationId} />
      ) : null}
    </>
  );

  if (placement === "composer") {
    // A bare group, not a row of its own: the composer's settings row owns the
    // layout, and this sits at its leading edge while Relaxed and Balanced hold
    // the trailing one. `--side-control-size` drops these to the pills' 32px so
    // the row reads as one set of controls rather than two sizes side by side.
    return (
      <div
        aria-label={t("progressRail.railAria")}
        className="flex flex-row items-center gap-1.5"
        style={{ "--side-control-size": "32px" } as CSSProperties}
      >
        {controls}
      </div>
    );
  }

  return (
    // Absolutely positioned, so it shrink-wraps its pills and the transcript
    // stays scrollable around them.
    //
    // Flush top and right, deliberately. The chat column's right edge is inset
    // by the same 16px as the header's content edge (ChatLayout's `p-4` row vs
    // the header's `px-4`), so no right padding lands the cluster's right edge
    // on the notification bell's; no top padding lines the first pill up with
    // the bell's own row. Only the left keeps an inset, holding the pills off
    // the transcript beside them.
    <div
      aria-label={t("progressRail.railAria")}
      className={cn(
        "absolute right-0 top-0 z-20",
        "flex flex-col items-end gap-2 pl-3",
      )}
    >
      {controls}
    </div>
  );
}
