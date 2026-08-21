import { Tag } from "@vellumai/design-library/components/tag";
import type { TagTone } from "@vellumai/design-library/components/tag";
import { CheckCircle, CircleDashed, RefreshCw } from "lucide-react";

import { useTranslation } from "@/i18n";
import type { AssistantChannelState } from "@/types/channel-types";

interface ChannelHealthTagProps {
  /** Absent reads as connected: the channel measures nothing operational. */
  health?: AssistantChannelState["health"];
}

const TONE_BY_HEALTH = {
  ok: {
    tone: "positive",
    icon: <CheckCircle />,
    labelKey: "connectionCard.connected",
  },
  failing: {
    tone: "warning",
    icon: <RefreshCw />,
    labelKey: "connectionCard.reconnecting",
  },
  unknown: {
    tone: "neutral",
    icon: <CircleDashed />,
    labelKey: "connectionCard.statusUnavailable",
  },
} as const satisfies Record<
  "ok" | "failing" | "unknown",
  { tone: TagTone; icon: React.ReactNode; labelKey: string }
>;

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
  const { t } = useTranslation("channels");
  const { tone, icon, labelKey } = TONE_BY_HEALTH[health ?? "ok"];
  return (
    <Tag tone={tone} leftIcon={icon}>
      {t(labelKey)}
    </Tag>
  );
}
