import type { ReactNode } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";
import type { AssistantChannelState } from "@/types/channel-types";

import { ChannelHealthTag } from "./channel-health-tag";
import { publicAsset } from "@/utils/public-asset";

interface SlackConnectionCardProps {
  health?: AssistantChannelState["health"];
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
          <ChannelHealthTag health={health} />
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
