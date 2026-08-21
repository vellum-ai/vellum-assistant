import { Tag } from "@vellumai/design-library/components/tag";

import type { AssistantChannelState } from "@/types/channel-types";
import { useChannelHealthBadge } from "@/utils/channel-presentation";

interface ChannelHealthTagProps {
  health?: AssistantChannelState["health"];
}

/**
 * The badge a connected channel card wears.
 *
 * Deliberately calm rather than an alarm. A configured channel reports
 * `failing` while its transport is down, and the gateway reconnects itself
 * within about forty seconds, so a reader has nothing to act on. The failures
 * a reader can act on are credential failures, and those fail a configuration
 * check instead, which shows the setup wizard rather than a card wearing this.
 */
export function ChannelHealthTag({ health }: ChannelHealthTagProps) {
  const { Icon, label, tone } = useChannelHealthBadge(health);
  return (
    <Tag tone={tone} leftIcon={<Icon />}>
      {label}
    </Tag>
  );
}
