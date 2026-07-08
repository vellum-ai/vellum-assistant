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

  return (
    <PanelItem asChild active={selected} label={getChannelLabel(channel.key)}>
      <button
        type="button"
        onClick={onClick}
        className="flex h-auto w-full items-center gap-3 rounded-[6px] px-[8px] py-2 text-left"
      >
        <AdapterIcon channelKey={channel.key} />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <span className="truncate text-body-medium-default">
            {getChannelLabel(channel.key)}
          </span>
          <Tag tone={connected ? "positive" : "neutral"}>
            {connected ? "Connected" : "Not connected"}
          </Tag>
        </span>
      </button>
    </PanelItem>
  );
}

/**
 * Adapter tile: the Slack brand mark for Slack (its Lucide stand-in is a
 * bare `#`), and the shared Lucide channel glyph for the rest (Telegram's
 * paper plane, Phone's handset). Rendered in a uniform rounded square so the
 * three rows line up as consistent app tiles.
 */
function AdapterIcon({ channelKey }: { channelKey: SetupChannelId }) {
  if (channelKey === "slack") {
    return (
      <img
        src={publicAsset("/images/integrations/slack.svg")}
        alt=""
        className="size-6 shrink-0 rounded-[6px] bg-[var(--surface-sunken)] p-1"
      />
    );
  }

  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[var(--surface-sunken)]">
      <ChannelIcon
        channelId={channelKey}
        className="size-3.5 text-[color:var(--content-secondary)]"
      />
    </span>
  );
}
