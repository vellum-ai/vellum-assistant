import { Plug } from "lucide-react";

import { useTranslation } from "@/i18n";

import { Card } from "@vellumai/design-library/components/card";
import { PanelItem } from "@vellumai/design-library/components/panel-item";
import { Tag } from "@vellumai/design-library/components/tag";

import {
  ChannelIcon,
  PluginChannelIcon,
  getChannelLabel,
} from "@/utils/channel-presentation";
import type {
  AssistantChannelState,
  ChannelRowKey,
  PluginChannelSummary,
} from "@/types/channel-types";

export interface ChannelAdapterListProps {
  channels: AssistantChannelState[];
  /** Channels installed plugins bring. Listed with the rest. */
  pluginChannels?: PluginChannelSummary[];
  selectedKey: ChannelRowKey;
  onSelect: (key: ChannelRowKey) => void;
}

/**
 * The Channels tab's left rail: a vertical list of the assistant's adapters
 * (Slack, Telegram, Phone), each row showing the adapter icon, its name, and
 * a connected / not-connected status badge. Selecting a row swaps the detail
 * panel beside it. Mirrors the Contacts tab's `ContactsList` — same `Card`
 * shell, same `PanelItem` selection treatment — so the two About Assistant
 * tabs read as siblings.
 *
 * The card carries no "Channels" heading of its own: every surface that
 * mounts it already names it (`IntelligenceLayout`'s section `<h1>` on
 * desktop, the `SideListDrawer` title in a pane too narrow to seat this
 * beside the detail), so one here would put the word on screen twice.
 *
 * Channels a plugin brings sit in the same list as the rest. They are
 * channels, they are selected the same way, and their panel is the thing
 * that differs; a heading over them would sort the list by who supplies a
 * channel, which is not what someone scanning it is looking for. A plug
 * marks them instead.
 */
export function ChannelAdapterList({
  channels,
  pluginChannels = [],
  selectedKey,
  onSelect,
}: ChannelAdapterListProps) {
  return (
    <Card.Root className="flex h-full flex-col overflow-hidden">
      <Card.Body className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-col gap-1">
          {channels.map((channel) => (
            <AdapterRow
              key={channel.key}
              channel={channel}
              selected={channel.key === selectedKey}
              onClick={() => onSelect(channel.key)}
            />
          ))}

          {/* After the built-ins rather than interleaved, so installing a
              plugin appends to the list instead of reordering it. */}
          {pluginChannels.map((channel) => (
            <PluginRow
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
    // The status is folded into the accessible name: otherwise screen readers
    // announce only "Slack" and miss the connection state, which is the row's
    // whole point.
    <PanelItem
      asChild
      active={selected}
      aria-label={`${label}, ${statusLabel}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex h-auto w-full items-center gap-2 rounded-[6px] px-[8px] py-2 text-left"
      >
        <ChannelIcon
          channelId={channel.key}
          className="h-4 w-4 shrink-0 text-[color:var(--content-secondary)]"
        />
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

interface PluginRowProps {
  channel: PluginChannelSummary;
  selected: boolean;
  onClick: () => void;
}

/**
 * Sibling of {@link AdapterRow} carrying a plug where a built-in carries its
 * status badge.
 *
 * No connection status: nothing in this client can tell whether an arbitrary
 * plugin's channel is connected, and a badge permanently reading "Not
 * connected" would be a false claim rather than an honest gap. The plug says
 * the one thing this client does know, which is where the channel came from.
 */
function PluginRow({ channel, selected, onClick }: PluginRowProps) {
  const { t } = useTranslation("channels");
  return (
    // The plug is decorative, so the aria-label carries the same fact in
    // words. Without it a screen reader announces a plugin channel and a
    // built-in identically.
    <PanelItem
      asChild
      active={selected}
      aria-label={t("channelAdapterList.pluginChannelAria", {
        channel: channel.label,
      })}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex h-auto w-full items-center gap-2 rounded-[6px] px-[8px] py-2 text-left"
      >
        <PluginChannelIcon
          icon={channel.icon}
          className="h-4 w-4 shrink-0 text-[color:var(--content-secondary)]"
        />
        <span className="min-w-0 flex-1 truncate text-body-medium-default">
          {channel.label}
        </span>
        <Plug
          aria-hidden
          className="h-4 w-4 shrink-0 text-[color:var(--content-secondary)]"
        />
      </button>
    </PanelItem>
  );
}
