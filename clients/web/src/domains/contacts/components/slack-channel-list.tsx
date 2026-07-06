import { CheckCircle, Hash, Lock, MessageCircle, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@vellumai/design-library";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";
import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import { EmptyState } from "@/components/empty-state";
import type { SlackChannel } from "@/domains/contacts/types";

/**
 * How a channel presents in the filter chips. Mutually exclusive: DMs are
 * 1:1 conversations, everything else splits on `isPrivate` (group DMs and
 * legacy private groups count as private).
 */
export type SlackChannelKind = "public" | "private" | "dm";

export function classifySlackChannelKind(channel: SlackChannel): SlackChannelKind {
  if (channel.type === "dm") {
    return "dm";
  }
  return channel.isPrivate ? "private" : "public";
}

/**
 * Applies the chip filter (`null` = all kinds) and name search, then sorts
 * alphabetically by name.
 */
export function filterSlackChannels(
  channels: SlackChannel[],
  search: string,
  kind: SlackChannelKind | null,
): SlackChannel[] {
  const query = search.trim().toLowerCase();
  return channels
    .filter(
      (channel) =>
        (kind === null || classifySlackChannelKind(channel) === kind) &&
        (query === "" || channel.name.toLowerCase().includes(query)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

const CHANNEL_KIND_FILTERS: { value: SlackChannelKind; label: string }[] = [
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
  { value: "dm", label: "DMs" },
];

const CHANNEL_KIND_ICONS: Record<SlackChannelKind, typeof Hash> = {
  public: Hash,
  private: Lock,
  dm: MessageCircle,
};

/**
 * A workspace can have hundreds of channels; past this row count the list
 * switches to the virtualized scroller instead of rendering every row.
 */
const VIRTUALIZE_THRESHOLD = 100;

export interface SlackChannelListProps {
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantDisplayName: string;
  /**
   * The assistant's Slack handle (e.g. "@example-assistant") for the
   * `/invite` hint. Falls back to the display name when unknown.
   */
  slackHandle?: string;
  channels?: SlackChannel[];
  loading?: boolean;
  error?: boolean;
}

/**
 * Presence-only channel list for the Slack sub-tab: every Slack channel the
 * assistant is a member of, with a per-row presence badge. Search and the
 * kind chips narrow the list client-side; the membership filter itself is
 * server-side (`?memberOnly=true`) with no toggle.
 */
export function SlackChannelList({
  assistantDisplayName,
  slackHandle,
  channels,
  loading = false,
  error = false,
}: SlackChannelListProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<SlackChannelKind | null>(null);

  const visibleChannels = useMemo(
    () => filterSlackChannels(channels ?? [], search, kindFilter),
    [channels, search, kindFilter],
  );

  const inviteHint = (
    <Typography
      as="p"
      variant="body-small-default"
      className="text-[color:var(--content-tertiary)]"
    >
      Only showing channels {assistantDisplayName} is in. To add{" "}
      {assistantDisplayName} to a channel, type{" "}
      <code className="text-[color:var(--content-secondary)]">
        /invite {slackHandle ?? `@${assistantDisplayName}`}
      </code>{" "}
      inside that Slack channel.
    </Typography>
  );

  return (
    <Card.Root>
      <Card.Header>
        <Typography as="span" variant="body-medium-default">
          Channels
        </Typography>
      </Card.Header>
      <Card.Body>
        {loading ? (
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[color:var(--content-tertiary)]"
          >
            Loading…
          </Typography>
        ) : error ? (
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[color:var(--content-negative)]"
          >
            Couldn’t load channels. Try reopening this page.
          </Typography>
        ) : (channels ?? []).length === 0 ? (
          <EmptyState
            icon={<Hash className="h-6 w-6" />}
            title="No channels yet"
            description={inviteHint}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search channels"
              aria-label="Search channels"
              leftIcon={<Search className="h-4 w-4" />}
              fullWidth
            />
            <div
              className="flex items-center gap-2"
              role="group"
              aria-label="Filter channels by type"
            >
              {CHANNEL_KIND_FILTERS.map(({ value, label }) => {
                const active = kindFilter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setKindFilter(active ? null : value)}
                    className={cn(
                      "inline-flex h-6 items-center rounded-full px-2.5 text-body-small-emphasised leading-none transition-colors",
                      active
                        ? "bg-[var(--content-default)] text-[var(--surface-base)]"
                        : "bg-[var(--tag-bg-neutral)] text-[color:var(--content-secondary)] hover:text-[color:var(--content-default)]",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {visibleChannels.length === 0 ? (
              <Typography
                as="span"
                variant="body-small-default"
                className="py-4 text-center text-[color:var(--content-tertiary)]"
              >
                No channels match.
              </Typography>
            ) : visibleChannels.length > VIRTUALIZE_THRESHOLD ? (
              // Virtuoso sizes its scroller to 100% of the wrapper, so the
              // fixed height lives on the wrapper, not the list itself.
              <div className="h-96">
                <VirtualList
                  items={visibleChannels}
                  computeItemKey={(_, channel) => channel.id}
                  itemContent={(_, channel) => (
                    <SlackChannelRow channel={channel} />
                  )}
                  className="h-full"
                />
              </div>
            ) : (
              <div className="flex flex-col">
                {visibleChannels.map((channel) => (
                  <SlackChannelRow key={channel.id} channel={channel} />
                ))}
              </div>
            )}
            {inviteHint}
          </div>
        )}
      </Card.Body>
    </Card.Root>
  );
}

function SlackChannelRow({ channel }: { channel: SlackChannel }) {
  const kind = classifySlackChannelKind(channel);
  const Icon = CHANNEL_KIND_ICONS[kind];
  return (
    <ListRow
      leading={<Icon className="h-4 w-4 text-[var(--content-tertiary)]" />}
      title={channel.name}
      trailing={
        channel.isMember ? (
          <Tag tone="positive" leftIcon={<CheckCircle />}>
            In channel
          </Tag>
        ) : (
          <Tag tone="neutral">Not in channel</Tag>
        )
      }
    />
  );
}
