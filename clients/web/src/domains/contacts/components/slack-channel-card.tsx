import type { ReactNode } from "react";

import { Card } from "@vellumai/design-library/components/card";
import { Typography } from "@vellumai/design-library/components/typography";

import { publicAsset } from "@/utils/public-asset";

interface SlackChannelCardProps {
  children: ReactNode;
}

/**
 * The "Slack setup" card wrapping the setup wizard for a disconnected
 * Slack. A connected Slack renders `SlackConnectionCard` instead.
 */
export function SlackChannelCard({ children }: SlackChannelCardProps) {
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
            Slack setup
          </Typography>
        </div>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}
