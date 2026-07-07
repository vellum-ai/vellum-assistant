import { Hash, Lock, Search, User } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@vellumai/design-library";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";
import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import { EmptyState } from "@/components/empty-state";
import { isVerifiedContactChannel } from "@/domains/contacts/components/contact-channels-section";
import type { ContactPayload, SlackChannel } from "@/domains/contacts/types";
import {
  RESOLVED_ROOM_ACCESS_LABELS,
  RESOLVED_ROOM_ACCESS_TONES,
  type ResolvedRoomAccess,
} from "@/lib/channel-admission-policy/resolved-access";

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

/** Per-kind row counts for the filter chips (search-independent). */
export function countSlackChannelKinds(
  channels: SlackChannel[],
): Record<SlackChannelKind, number> {
  const counts: Record<SlackChannelKind, number> = {
    public: 0,
    private: 0,
    dm: 0,
  };
  for (const channel of channels) {
    counts[classifySlackChannelKind(channel)] += 1;
  }
  return counts;
}

/**
 * Right-aligned row metadata: DMs read "Direct message", everything else
 * shows its member count when Slack reports one.
 */
export function slackChannelMetaLabel(channel: SlackChannel): string | null {
  if (classifySlackChannelKind(channel) === "dm") {
    return "Direct message";
  }
  if (channel.memberCount == null) {
    return null;
  }
  return channel.memberCount === 1
    ? "1 member"
    : `${channel.memberCount} members`;
}

function normalizeSlackDmName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Normalized display names of contacts with a verified Slack channel — the
 * lookup behind the DM rows' resolved-access badges. Matching is by display
 * name because the channel list exposes each DM peer's Slack display name
 * but not their Slack user id.
 */
export function buildVerifiedSlackContactNames(
  contacts: ContactPayload[],
): Set<string> {
  const names = new Set<string>();
  for (const contact of contacts) {
    const hasVerifiedSlack = contact.channels.some(
      (channel) => channel.type === "slack" && isVerifiedContactChannel(channel),
    );
    if (hasVerifiedSlack) {
      names.add(normalizeSlackDmName(contact.displayName));
    }
  }
  return names;
}

/**
 * The Slack adapter's room-access derivation: public/private channels and
 * group DMs admit at full trust; 1:1 DMs admit at full trust only when the
 * peer is a verified contact, and are strict otherwise. Derived from channel
 * type + contact trust class; per-channel overrides
 * (`channel_permission_overrides`) are not consulted.
 */
export function resolveSlackChannelAccess(
  channel: SlackChannel,
  verifiedDmContactNames: ReadonlySet<string>,
): ResolvedRoomAccess {
  if (classifySlackChannelKind(channel) !== "dm") {
    return "full_access";
  }
  return verifiedDmContactNames.has(normalizeSlackDmName(channel.name))
    ? "full_access"
    : "strict";
}

const CHANNEL_KIND_FILTERS: {
  value: SlackChannelKind | null;
  label: string;
}[] = [
  { value: null, label: "All" },
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
  { value: "dm", label: "DMs" },
];

const CHANNEL_KIND_ICONS: Record<SlackChannelKind, typeof Hash> = {
  public: Hash,
  private: Lock,
  dm: User,
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
   * `/invite` and `/remove` hints. Falls back to the display name when
   * unknown.
   */
  slackHandle?: string;
  channels?: SlackChannel[];
  loading?: boolean;
  error?: boolean;
  /**
   * Lookup for the DM rows' resolved-access badges (see
   * {@link buildVerifiedSlackContactNames}). DMs resolve strict while it is
   * absent (contacts still loading).
   */
  verifiedDmContactNames?: ReadonlySet<string>;
}

const EMPTY_VERIFIED_NAMES: ReadonlySet<string> = new Set();

/**
 * Presence channel list for the Slack sub-tab: every Slack channel the
 * assistant is a member of, with a per-row resolved-access badge. Search and
 * the kind chips narrow the list client-side; the membership filter itself
 * is server-side (`?memberOnly=true`) with no toggle.
 */
export function SlackChannelList({
  assistantDisplayName,
  slackHandle,
  channels,
  loading = false,
  error = false,
  verifiedDmContactNames = EMPTY_VERIFIED_NAMES,
}: SlackChannelListProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<SlackChannelKind | null>(null);

  const allChannels = channels ?? [];
  const visibleChannels = useMemo(
    () => filterSlackChannels(channels ?? [], search, kindFilter),
    [channels, search, kindFilter],
  );
  const kindCounts = useMemo(
    () => countSlackChannelKinds(channels ?? []),
    [channels],
  );

  const handle = slackHandle ?? `@${assistantDisplayName}`;
  const inviteHint = (
    <>
      To add {assistantDisplayName} to a channel, type{" "}
      <code className="text-[color:var(--content-secondary)]">
        /invite {handle}
      </code>{" "}
      inside that Slack channel.
    </>
  );

  return (
    <Card.Root>
      <Card.Body>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Typography as="h3" variant="title-small">
              Where {assistantDisplayName} is present
            </Typography>
            <Typography
              as="p"
              variant="body-small-default"
              className="text-[color:var(--content-tertiary)]"
            >
              {inviteHint}
            </Typography>
          </div>
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
          ) : allChannels.length === 0 ? (
            <EmptyState
              icon={<Hash className="h-6 w-6" />}
              title="No channels yet"
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-56 flex-1">
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search channels"
                    aria-label="Search channels"
                    leftIcon={<Search className="h-4 w-4" />}
                    fullWidth
                  />
                </div>
                <div
                  className="flex items-center gap-2"
                  role="group"
                  aria-label="Filter channels by type"
                >
                  {CHANNEL_KIND_FILTERS.map(({ value, label }) => {
                    const active = kindFilter === value;
                    const count =
                      value === null ? allChannels.length : kindCounts[value];
                    return (
                      <button
                        key={value ?? "all"}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setKindFilter(value)}
                        className={cn(
                          "inline-flex h-6 items-center rounded-full px-2.5 text-body-small-emphasised leading-none transition-colors",
                          active
                            ? "bg-[var(--content-default)] text-[var(--surface-base)]"
                            : "bg-[var(--tag-bg-neutral)] text-[color:var(--content-secondary)] hover:text-[color:var(--content-default)]",
                        )}
                      >
                        {label} {count}
                      </button>
                    );
                  })}
                </div>
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
                      <SlackChannelRow
                        channel={channel}
                        verifiedDmContactNames={verifiedDmContactNames}
                      />
                    )}
                    className="h-full"
                  />
                </div>
              ) : (
                <div className="flex flex-col">
                  {visibleChannels.map((channel) => (
                    <SlackChannelRow
                      key={channel.id}
                      channel={channel}
                      verifiedDmContactNames={verifiedDmContactNames}
                    />
                  ))}
                </div>
              )}
              <Typography
                as="p"
                variant="body-small-default"
                className="text-[color:var(--content-tertiary)]"
              >
                Only showing channels {assistantDisplayName} is in. To remove{" "}
                {assistantDisplayName} from a channel, use{" "}
                <code className="text-[color:var(--content-secondary)]">
                  /remove {handle}
                </code>{" "}
                in that Slack channel.
              </Typography>
            </>
          )}
        </div>
      </Card.Body>
    </Card.Root>
  );
}

function SlackChannelRow({
  channel,
  verifiedDmContactNames,
}: {
  channel: SlackChannel;
  verifiedDmContactNames: ReadonlySet<string>;
}) {
  const kind = classifySlackChannelKind(channel);
  const Icon = CHANNEL_KIND_ICONS[kind];
  const access = resolveSlackChannelAccess(channel, verifiedDmContactNames);
  const metaLabel = slackChannelMetaLabel(channel);
  return (
    <ListRow
      leading={<Icon className="h-4 w-4 text-[var(--content-tertiary)]" />}
      title={channel.name}
      trailing={
        <>
          {metaLabel != null ? (
            <span className="text-body-small-default text-[color:var(--content-tertiary)]">
              {metaLabel}
            </span>
          ) : null}
          <Tag tone={RESOLVED_ROOM_ACCESS_TONES[access]}>
            {RESOLVED_ROOM_ACCESS_LABELS[access]}
          </Tag>
        </>
      }
    />
  );
}
