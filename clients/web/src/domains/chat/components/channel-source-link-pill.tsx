import { ExternalLink } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { getChannelLabel } from "@/utils/channel-presentation";

export interface ChannelSourceLinkPillProps {
  /** Deep link to the conversation's source in the external channel —
   *  the Slack thread when one exists, otherwise the message or channel. */
  href: string;
  /** Originating channel id (e.g. `"slack"`), used for the icon and label. */
  channelId: string | null;
}

/**
 * Top-bar pill linking a channel-bound conversation back to its source
 * thread in the external channel. Rendered next to ConversationAssetsPill
 * for conversations that originate from Slack (and, once their bindings
 * carry links, other channels).
 */
export function ChannelSourceLinkPill({
  href,
  channelId,
}: ChannelSourceLinkPillProps) {
  const isMobile = useIsMobile();
  const label = `Open in ${getChannelLabel(channelId)}`;
  const icon =
    channelId === "slack" ? (
      <img
        src="/images/integrations/slack.svg"
        alt=""
        className="h-3.5 w-3.5"
      />
    ) : (
      <ExternalLink />
    );

  if (isMobile) {
    return (
      <Button
        asChild
        variant="ghost"
        active
        iconOnly={icon}
        tintColor="var(--content-default)"
      >
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={label}
        />
      </Button>
    );
  }

  return (
    <Button
      asChild
      variant="ghost"
      active
      leftIcon={icon}
      className="rounded-full"
      tintColor="var(--content-default)"
    >
      <a href={href} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    </Button>
  );
}
