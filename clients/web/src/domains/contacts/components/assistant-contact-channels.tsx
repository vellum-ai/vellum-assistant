import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { Link } from "react-router";

import { routes } from "@/utils/routes";
import { useTranslation } from "@/i18n";
import type {
  AssistantChannelState,
  SetupChannelId,
} from "@/types/channel-types";
import {
  ChannelIcon,
  getChannelLabel,
  useChannelHealthBadge,
} from "@/utils/channel-presentation";

export interface AssistantContactChannelsProps {
  channels: AssistantChannelState[];
  /** Channel with a disconnect in flight; disables that row's actions. */
  pendingChannelKey?: SetupChannelId | null;
  onConnect?: (channelKey: SetupChannelId) => void;
  onDisconnect?: (channelKey: SetupChannelId) => void;
}

/**
 * Connected/disconnected summary of the assistant's own outbound channels,
 * for its entry in the Contacts detail pane: one row per adapter with a
 * Connect / Disconnect action. Mirrors the row shape of the human contact
 * detail's `ContactChannelsSection`. Everything richer — credential forms,
 * trust floors, Slack settings, the channel list — lives in the Channels
 * tab's `AssistantChannelsList`.
 */
export function AssistantContactChannels({
  channels,
  pendingChannelKey = null,
  onConnect,
  onDisconnect,
}: AssistantContactChannelsProps) {
  const { t } = useTranslation("contacts");
  const [pendingDisconnect, setPendingDisconnect] =
    useState<SetupChannelId | null>(null);

  return (
    <>
      <div className="flex flex-col">
        {channels.map((channel, index) => (
          <div key={channel.key}>
            {index > 0 ? (
              <div
                className="border-t"
                style={{ borderColor: "var(--border-base)" }}
              />
            ) : null}
            <ChannelRow
              channel={channel}
              pending={pendingChannelKey === channel.key}
              onConnect={onConnect ? () => onConnect(channel.key) : undefined}
              onDisconnect={
                // Offered only where a route can clear the credentials, so
                // the confirm can never resolve without doing anything.
                onDisconnect && channel.canDisconnect
                  ? () => setPendingDisconnect(channel.key)
                  : undefined
              }
            />
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title={t("assistantContactChannels.disconnectConfirmTitle", {
          channel: pendingDisconnect ? getChannelLabel(pendingDisconnect) : "",
        })}
        message={t("assistantContactChannels.disconnectConfirmMessage")}
        confirmLabel={t("actions.disconnect")}
        destructive
        onConfirm={() => {
          if (pendingDisconnect && onDisconnect) {
            onDisconnect(pendingDisconnect);
          }
          setPendingDisconnect(null);
        }}
        onCancel={() => setPendingDisconnect(null)}
      />
    </>
  );
}

interface ChannelRowProps {
  channel: AssistantChannelState;
  pending: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

function ChannelRow({
  channel,
  pending,
  onConnect,
  onDisconnect,
}: ChannelRowProps) {
  const { t } = useTranslation("contacts");
  // Two axes, two decisions. `configured` owns the action and the address,
  // because a channel that is merely not delivering still has credentials
  // worth keeping and an address worth showing, and offering Connect would
  // start a fresh setup conversation for a channel that is already set up.
  // `health` owns the label, which is the only part an outage changes.
  const configured = channel.configured;
  const { Icon, label } = useChannelHealthBadge(channel.health);

  return (
    <div className="flex items-center gap-3 py-4">
      <ChannelIcon
        channelId={channel.key}
        className="h-4 w-4 shrink-0 text-[color:var(--content-secondary)]"
      />
      <span
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {getChannelLabel(channel.key)}
      </span>
      {configured && channel.address ? (
        <span
          className="truncate text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {channel.address}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {configured ? (
          <>
            <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md whitespace-nowrap select-none text-body-small-emphasised leading-none bg-[var(--content-default)] text-[var(--surface-base)]">
              <Icon className="h-3 w-3" />
              {label}
            </span>
            {/* No handler means no one-click disconnect exists for this row:
                either the daemon predates the channel's delete route, or the
                channel declares none because tearing it down is a multi-step
                decision (email). The row links to the channel's panel, where
                the real controls live, instead of a permanently dead button. */}
            {onDisconnect ? (
              <Button
                variant="danger"
                onClick={onDisconnect}
                disabled={pending}
              >
                {pending ? t("actions.disconnecting") : t("actions.disconnect")}
              </Button>
            ) : (
              <Button variant="outlined" asChild>
                <Link to={`${routes.channels}?setup=${channel.key}`}>
                  {t("actions.manage")}
                </Link>
              </Button>
            )}
          </>
        ) : onConnect ? (
          <Button variant="outlined" onClick={onConnect} disabled={pending}>
            {t("actions.connect")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
