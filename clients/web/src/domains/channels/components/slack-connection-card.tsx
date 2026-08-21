import { CheckCircle, CircleDashed, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";
import { publicAsset } from "@/utils/public-asset";

interface SlackConnectionCardProps {
  /** Operational health; absent reads as connected. */
  health?: "ok" | "failing" | "unknown";
  /** The assistant's Slack @handle, when known. */
  slackHandle?: string;
  /** Disconnect in flight; disables the button and swaps its label. */
  disconnectPending?: boolean;
  onDisconnect?: () => void;
  children: ReactNode;
}

/**
 * The consolidated card for a connected Slack on the Channels tab: one
 * header row with the Slack logo, @handle, Connected chip, and a
 * right-aligned low-weight Disconnect affordance (the caller confirms
 * before disconnecting), with the Slack settings as the body. A
 * disconnected Slack renders `SlackChannelCard` + `SlackSetupWizard`
 * instead.
 */
export function SlackConnectionCard({
  slackHandle,
  health,
  disconnectPending = false,
  onDisconnect,
  children,
}: SlackConnectionCardProps) {
  const { t } = useTranslation("channels");
  // Deliberately calm rather than an alarm. A configured channel reports
  // `failing` while its socket is down, and the gateway reconnects itself
  // within about forty seconds, so there is nothing for the reader to do. The
  // failures a reader can act on are credential failures, and those fail a
  // configuration check instead, which shows the setup wizard rather than
  // this card.
  const [statusTone, statusIcon, statusLabelKey] =
    health === "failing"
      ? ([
          "warning",
          <RefreshCw key="i" />,
          "connectionCard.reconnecting",
        ] as const)
      : health === "unknown"
        ? ([
            "neutral",
            <CircleDashed key="i" />,
            "connectionCard.statusUnavailable",
          ] as const)
        : ([
            "positive",
            <CheckCircle key="i" />,
            "connectionCard.connected",
          ] as const);
  return (
    <Card.Root>
      <Card.Header>
        <div className="flex items-center gap-3">
          <img
            src={publicAsset("/images/integrations/slack.svg")}
            alt=""
            className="size-8 rounded-lg bg-[var(--surface-sunken)] p-1"
          />
          {slackHandle ? (
            <Typography as="span" variant="body-medium-default">
              {slackHandle}
            </Typography>
          ) : null}
          <Tag tone={statusTone} leftIcon={statusIcon}>
            {t(statusLabelKey)}
          </Tag>
          <div className="ml-auto">
            <Button
              type="button"
              variant="ghost"
              onClick={onDisconnect}
              disabled={!onDisconnect || disconnectPending}
            >
              {disconnectPending
                ? t("connectionCard.disconnecting")
                : t("connectionCard.disconnect")}
            </Button>
          </div>
        </div>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}
