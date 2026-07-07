import { CheckCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import type { AssistantChannelState, SetupChannelId } from "@/domains/contacts/types";
import { ChannelIcon, getChannelLabel } from "@/utils/channel-presentation";

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
  const [pendingDisconnect, setPendingDisconnect] = useState<SetupChannelId | null>(null);

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
                onDisconnect ? () => setPendingDisconnect(channel.key) : undefined
              }
            />
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title={`Disconnect ${pendingDisconnect ? getChannelLabel(pendingDisconnect) : ""}?`}
        message="This clears the stored credentials for this channel. You can reconnect later."
        confirmLabel="Disconnect"
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

function ChannelRow({ channel, pending, onConnect, onDisconnect }: ChannelRowProps) {
  const connected = channel.status === "ready";

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
      {connected && channel.address ? (
        <span
          className="truncate text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {channel.address}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {connected ? (
          <>
            <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md whitespace-nowrap select-none text-body-small-emphasised leading-none bg-[var(--content-default)] text-[var(--surface-base)]">
              <CheckCircle className="h-3 w-3" />
              Connected
            </span>
            <Button
              variant="danger"
              onClick={onDisconnect}
              disabled={!onDisconnect || pending}
            >
              {pending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </>
        ) : (
          <Button
            variant="outlined"
            onClick={onConnect}
            disabled={!onConnect || pending}
          >
            Connect
          </Button>
        )}
      </div>
    </div>
  );
}
