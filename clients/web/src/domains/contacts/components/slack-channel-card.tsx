import type { ReactNode } from "react";

import { Card } from "@vellumai/design-library/components/card";
import { Typography } from "@vellumai/design-library/components/typography";

import { publicAsset } from "@/utils/public-asset";

interface SlackChannelCardProps {
  assistantName: string;
  connected?: boolean;
  children: ReactNode;
}

export function SlackChannelCard({ assistantName, connected = false, children }: SlackChannelCardProps) {
  return (
    <Card.Root>
      <Card.Header>
        <div className="flex items-center gap-3">
          <img
            src={publicAsset("/images/integrations/slack.svg")}
            alt=""
            className="size-8 rounded-lg bg-[var(--surface-sunken)] p-1"
          />
          <div className="flex flex-col">
            <Typography as="span" variant="body-medium-default">
              {connected ? "Slack settings" : "Slack setup"}
            </Typography>
            {connected ? (
              <span className="flex items-center gap-1.5 text-body-small-default text-[var(--content-secondary)]">
                <span className="size-2 rounded-full bg-[var(--system-positive-strong)]" />
                Connected as {assistantName}
              </span>
            ) : null}
          </div>
        </div>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}
