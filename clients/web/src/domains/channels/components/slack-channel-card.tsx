import type { ReactNode } from "react";

import { Card } from "@vellumai/design-library/components/card";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";
import { publicAsset } from "@/utils/public-asset";

interface SlackChannelCardProps {
  children: ReactNode;
}

/**
 * The "{t("slackChannelCard.setupHeading")}" card wrapping the setup wizard for a disconnected
 * Slack. A connected Slack renders `SlackConnectionCard` instead.
 */
export function SlackChannelCard({ children }: SlackChannelCardProps) {
  const { t } = useTranslation("channels");
  return (
    <Card.Root>
      <Card.Header>
        <div className="flex items-center gap-3">
          <img
            src={publicAsset("/images/integrations/slack.svg")}
            alt=""
            className="size-8 rounded-lg bg-[var(--surface-sunken)] p-1"
          />
          <Typography as="span" variant="body-medium-default">
            {t("slackChannelCard.setupHeading")}
          </Typography>
        </div>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}
