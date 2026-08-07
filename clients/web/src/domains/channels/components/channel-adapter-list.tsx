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
  /** Channels installed plugins declare. Rendered under their own heading. */
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
 * desktop, the `MobileSidebarDrawer` title on mobile), so one here would
 * put the word on screen twice.
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
        </div>

        {/* Under their own heading rather than mixed in: these are managed by
            the plugin that brought them, not by this client, and the detail
            panel says as much. Absent entirely when nothing declares one, so
            an assistant with no channel plugins looks exactly as before. */}
        {pluginChannels.length > 0 ? (
          <>
            <h2
              className="text-label-small"
              style={{ color: "var(--content-secondary)" }}
            >
              From plugins
            </h2>

            <div className="flex flex-col gap-1">
              {pluginChannels.map((channel) => (
                <PluginRow
                  key={channel.id}
                  channel={channel}
                  selected={channel.id === selectedKey}
                  onClick={() => onSelect(channel.id)}
                />
              ))}
            </div>
          </>
        ) : null}
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
 * Sibling of {@link AdapterRow} without the status badge. Nothing in this
 * client can tell whether a plugin's channel is connected, and a badge that
 * always read "Not connected" would be a false claim rather than a missing
 * one. The plugin's own page answers it.
 */
function PluginRow({ channel, selected, onClick }: PluginRowProps) {
  return (
    <PanelItem asChild active={selected} label={channel.label}>
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
      </button>
    </PanelItem>
  );
}
