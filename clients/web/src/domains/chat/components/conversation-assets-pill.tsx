/**
 * The chat header's Layers control: the trigger for the Chat Info panel.
 *
 * Clicking it toggles the viewer store's `chat-info` view, which the drawer
 * renders beside the chat on a roomy window and the mobile overlay renders
 * full-screen under a thumb. The control itself reports the conversation's
 * asset count, or that those assets could not be loaded, carries the
 * unseen-changes dot, and reflects whether the panel is currently showing this
 * conversation.
 */

import { Layers } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useCallback, useLayoutEffect } from "react";

import { Button } from "@vellumai/design-library";

import { useConversationAssets } from "@/domains/chat/hooks/use-conversation-assets";
import { useHasUnseenDocumentChanges } from "@/domains/chat/unseen-document-changes-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { sameChatInfoTarget, useViewerStore } from "@/stores/viewer-store";
import { cn } from "@/utils/misc";

export const ASSETS_PILL_UNSEEN_DOT_TESTID = "assets-pill-unseen-dot";

/** Bounded attention pulse defined in `src/index.css`. */
export const ASSETS_PILL_UNSEEN_DOT_PULSE_CLASS = "unseen-dot-pulse";

/** Dismiss the chat-info panel when it is the one this trigger owns. */
function closeOwnedChatInfo(target: {
  assistantId: string;
  conversationId: string;
}): void {
  const state = useViewerStore.getState();
  if (sameChatInfoTarget(state, target)) {
    state.closeChatInfo();
  }
}

interface ConversationAssetsPillProps {
  assistantId: string;
  conversationId: string;
  /** Bumped externally to trigger a refetch (e.g. on ui_surface_show). */
  refreshKey?: number;
}

export function ConversationAssetsPill({
  assistantId,
  conversationId,
  refreshKey,
}: ConversationAssetsPillProps) {
  const { count, status } = useConversationAssets({
    assistantId,
    conversationId,
    refreshKey,
  });

  const mainView = useViewerStore.use.mainView();
  const activeChatInfo = useViewerStore.use.activeChatInfo();
  const isOpen = sameChatInfoTarget(
    { mainView, activeChatInfo },
    { assistantId, conversationId },
  );

  // The panel this pill opened must not outlive the pill's target: the chat
  // header swaps `conversationId` on this same mounted pill, and an assistant
  // switch unmounts it. `clearTranscriptPanelPayloads` settles the store on a
  // conversation switch, so this covers the paths that do not run it. Layout
  // effect: the outgoing panel must never paint over the incoming
  // conversation, not even for one frame.
  useLayoutEffect(() => {
    return () => {
      closeOwnedChatInfo({ assistantId, conversationId });
    };
  }, [assistantId, conversationId]);

  // The header cluster only has room for a labelled pill on a roomy window.
  const isMobile = useIsMobile();
  const { t } = useTranslation("chat");
  const reduceMotion = useReducedMotion();
  const hasUnseenChanges = useHasUnseenDocumentChanges(conversationId);

  const handleClick = useCallback(() => {
    useViewerStore.getState().toggleChatInfo({ assistantId, conversationId });
  }, [assistantId, conversationId]);

  // A conversation with nothing to show has no trigger, and neither does one
  // whose sources have not settled: counting nothing yet is not the same as
  // holding nothing, and a partial total that changes as the other sources
  // land is worse than none. A failed load keeps it: the panel is where the
  // user finds out why.
  const failedToLoad = status === "error";
  if (status === "pending" || (count === 0 && !failedToLoad)) {
    return null;
  }

  // ICU `plural` picks the category through `Intl.PluralRules` for the active
  // locale, so both strings agree with `count` in languages with more than the
  // two forms English has. The unseen variant is its own key rather than a
  // `select` branch appended to the base one: translators get a whole sentence
  // to work with, and languages that place the qualifier somewhere other than
  // the end are free to move it. A failed load names no count at all, since
  // what reached the client is a fraction of what the conversation holds.
  const countedAriaLabel = hasUnseenChanges
    ? t("conversationAssets.ariaLabelUnseen", { count })
    : t("conversationAssets.ariaLabel", { count });
  const label = failedToLoad
    ? t("conversationAssets.labelUnavailable")
    : t("conversationAssets.label", { count });
  const ariaLabel = failedToLoad
    ? t("conversationAssets.ariaLabelUnavailable")
    : countedAriaLabel;
  // The dot points at changes in a list the trigger could not load, and the
  // name it sits beside no longer mentions them.
  const showUnseenDot = hasUnseenChanges && !failedToLoad;

  // Same dot as the notifications bell in this header cluster: ringed in the
  // color of the surface behind it so the ring reads as a gap carved out of
  // the icon. The dot mounts only while changes are unseen, so the CSS pulse
  // runs on appearance and needs no restart bookkeeping.
  //
  // This wrapper is the dot's positioning context and the element the Button
  // sizes in place of the glyph. `iconOnly` sizes the glyph with its own
  // `[&_svg]` rule, which reaches through the wrapper, so a size rule here
  // would only compete with it. `leftIcon` sizes just the box it provides, so
  // there the wrapper fills that box and hands the size down to the glyph.
  const layersIcon = (
    <span
      className={cn(
        "relative flex",
        !isMobile && "size-full [&_svg]:size-full",
      )}
      aria-hidden
    >
      <Layers />
      {showUnseenDot ? (
        <span
          data-testid={ASSETS_PILL_UNSEEN_DOT_TESTID}
          className={cn(
            "absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-base)] bg-[var(--system-mid-strong)] touch-mobile:border-[var(--surface-lift)]",
            !reduceMotion && ASSETS_PILL_UNSEEN_DOT_PULSE_CLASS,
          )}
        />
      ) : null}
    </span>
  );

  if (isMobile) {
    return (
      <Button
        variant="ghost"
        active
        iconOnly={layersIcon}
        tintColor="var(--content-default)"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        onClick={handleClick}
      />
    );
  }

  // Desktop: a bare glyph, matching the notifications bell it shares the
  // header cluster with: same `ghost` + `iconOnly` Button and no pill. The
  // `active` fill marks the panel as the selected view. The count moves to the
  // tooltip and the accessible name, which is where the bell keeps its own
  // unread count too.
  return (
    <Button
      variant="ghost"
      active={isOpen}
      iconOnly={layersIcon}
      aria-label={ariaLabel}
      aria-expanded={isOpen}
      tooltip={label}
      onClick={handleClick}
    />
  );
}
