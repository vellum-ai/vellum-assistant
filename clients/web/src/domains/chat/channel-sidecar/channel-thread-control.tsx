/**
 * Top-bar control for a channel-bound conversation: opens and closes the
 * read-only channel drawer.
 *
 * Occupies the header slot that holds `ChannelSourceLinkPill` when the
 * sidecar flag is off. The pill is a link straight out of the app; this is a
 * toggle into the drawer, where the link lives as the secondary action. Same
 * slot, same footprint, so the header does not reflow between the two.
 *
 * Channel-neutral by construction: the label interpolates the channel's human
 * name from the presentation registry, so an adapter with no entry there still
 * renders a sensible control rather than nothing.
 */

import { Button } from "@vellumai/design-library";
import { PanelRight } from "lucide-react";

import type { ChannelSidecarTarget } from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { useViewerStore } from "@/stores/viewer-store";
import { ChannelIcon, getChannelLabel } from "@/utils/channel-presentation";

interface ChannelThreadControlProps {
  target: ChannelSidecarTarget;
}

export function ChannelThreadControl({ target }: ChannelThreadControlProps) {
  const { t } = useTranslation("chat");
  const isMobile = useIsMobile();
  const mainView = useViewerStore.use.mainView();
  const activeChannelTranscript =
    useViewerStore.use.activeChannelTranscript();

  const isOpen =
    mainView === "channel-transcript" &&
    activeChannelTranscript?.conversationId === target.conversationId;
  const channelLabel = getChannelLabel(target.channelId);
  const label = t("channelThreadControl.label", { channel: channelLabel });
  const ariaLabel = isOpen
    ? t("channelThreadControl.closeAria", { channel: channelLabel })
    : t("channelThreadControl.openAria", { channel: channelLabel });

  const onClick = () => {
    useViewerStore.getState().toggleChannelTranscript({
      conversationId: target.conversationId,
      channelId: target.channelId,
    });
  };

  const icon = (
    <ChannelIcon channelId={target.channelId} className="h-3.5 w-3.5" />
  );

  // Narrow viewports get the icon alone, matching the source-link pill's
  // mobile treatment: the top bar there has room for a glyph, not a
  // labelled pill.
  if (isMobile) {
    return (
      <Button
        variant="ghost"
        active={isOpen}
        iconOnly={icon}
        tintColor="var(--content-default)"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={onClick}
      />
    );
  }

  return (
    <Button
      variant="ghost"
      active={isOpen}
      leftIcon={icon}
      rightIcon={<PanelRight />}
      className="rounded-full"
      tintColor="var(--content-default)"
      aria-expanded={isOpen}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
