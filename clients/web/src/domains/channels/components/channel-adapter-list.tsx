import { Card } from "@vellumai/design-library/components/card";
import { PanelItem } from "@vellumai/design-library/components/panel-item";
import { Tag } from "@vellumai/design-library/components/tag";

import { ChannelIcon, getChannelLabel } from "@/utils/channel-presentation";
import { publicAsset } from "@/utils/public-asset";
import type {
  AssistantChannelState,
  SetupChannelId,
} from "@/types/channel-types";

export interface ChannelAdapterListProps {
  channels: AssistantChannelState[];
  selectedKey: SetupChannelId;
  onSelect: (key: SetupChannelId) => void;
}

/**
 * The Channels tab's left rail: a vertical list of the assistant's adapters
 * (Slack, Telegram, Phone), each row showing the adapter icon, its name, and
 * a connected / not-connected status badge. Selecting a row swaps the detail
 * panel beside it. Mirrors the Contacts tab's `ContactsList` — same `Card`
 * shell, same `PanelItem` selection treatment — so the two About Assistant
 * tabs read as siblings.
 */
export function ChannelAdapterList({
  channels,
  selectedKey,
  onSelect,
}: ChannelAdapterListProps) {
  return (
    <Card.Root className="flex h-full flex-col overflow-hidden">
      <Card.Body className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <h2
          className="text-title-medium"
          style={{ color: "var(--content-default)" }}
        >
          Channels
        </h2>

        <div className="flex flex-col gap-1">
          {channels.map((channel) => (
            <AdapterRow
              key={channel.key}
              channel={channel}
              selected={channel.key === selectedKey}
              onClick={() => onSelect(channel.key)}
            />
          ))}
        </div>
      </Card.Body>
    </Card.Root>
  );
}

interface AdapterRowProps {
  channel: AssistantChannelState;
  selected: boolean;
  onClick: () => void;
}

function AdapterRow({ channel, selected, onClick }: AdapterRowProps) {
  const connected = channel.status === "ready";
  const label = getChannelLabel(channel.key);
  const statusLabel = connected ? "Connected" : "Not connected";

  return (
    // `PanelItem` forwards `label` to the button's aria-label, so fold the
    // status into it — otherwise screen readers announce only "Slack" and miss
    // the connection state, which is the row's whole point.
    <PanelItem asChild active={selected} label={`${label}, ${statusLabel}`}>
      <button
        type="button"
        onClick={onClick}
        className="flex h-auto w-full items-center gap-2 rounded-[6px] px-[8px] py-2 text-left"
      >
        {channel.key === "slack" ? (
          // Slack ships a real brand logo (the same asset the connection card
          // uses); the shared ChannelIcon only has a `#` stand-in for it, so
          // render the logo directly. Telegram/Phone use their Lucide glyphs.
          <img
            src={publicAsset("/images/integrations/slack.svg")}
            alt=""
            className="h-4 w-4 shrink-0"
          />
        ) : (
          <ChannelIcon
            channelId={channel.key}
            className="h-4 w-4 shrink-0 text-[color:var(--content-secondary)]"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-body-medium-default">
          {label}
        </span>
        <span className="flex shrink-0 items-center">
          <Tag tone={connected ? "positive" : "neutral"}>{statusLabel}</Tag>
        </span>
      </button>
    </PanelItem>
  );
}
