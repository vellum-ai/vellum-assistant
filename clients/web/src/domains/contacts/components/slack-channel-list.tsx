import { ChevronDown, Hash, Lock, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { Input } from "@vellumai/design-library/components/input";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";
import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import { EmptyState } from "@/components/empty-state";
import { SlackChannelOverridePanel } from "@/domains/contacts/components/slack-channel-override-panel";
import { SlackChannelTierLegend } from "@/domains/contacts/components/slack-channel-tier-legend";
import {
  CAPABILITY_TIER_META,
  resolveChannelTier,
  type SlackCapabilityTier,
} from "@/domains/contacts/slack-channel-overrides";
import type { SlackChannel } from "@/domains/contacts/types";

/**
 * How a channel presents in the filter chips. Mirrors the conversation-type
 * axis of the channel-permission matrix (`ChannelConversationType` in
 * `packages/gateway-client/src/channel-permission-contract.ts`). Mutually
 * exclusive: DMs are 1:1 conversations, everything else splits on
 * `isPrivate` (group DMs and legacy private groups count as private).
 */
export type SlackChannelKind = "public" | "private" | "dm";

export function classifySlackChannelKind(channel: SlackChannel): SlackChannelKind {
  if (channel.type === "dm") {
    return "dm";
  }
  return channel.isPrivate ? "private" : "public";
}

/** Room kinds the presence list renders — 1:1 DMs are person-scoped, not rooms. */
export type SlackRoomKind = Exclude<SlackChannelKind, "dm">;

/**
 * The presence list is rooms only: channels and group DMs. 1:1 DMs are
 * person-scoped — how the assistant interacts with a person lives on their
 * contact, not on a room row.
 */
export function roomsOnly(channels: SlackChannel[]): SlackChannel[] {
  return channels.filter(
    (channel) => classifySlackChannelKind(channel) !== "dm",
  );
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

/** Right-aligned row metadata: the member count, when Slack reports one. */
export function slackChannelMetaLabel(channel: SlackChannel): string | null {
  if (channel.memberCount == null) {
    return null;
  }
  return channel.memberCount === 1
    ? "1 member"
    : `${channel.memberCount} members`;
}

const CHANNEL_KIND_FILTERS: {
  value: SlackRoomKind | null;
  label: string;
}[] = [
  { value: null, label: "All" },
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
];

const CHANNEL_KIND_ICONS: Record<SlackRoomKind, typeof Hash> = {
  public: Hash,
  private: Lock,
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
   * Persisted capabilities-tier override per channel id (from the gateway's
   * channel-permission cells). Channels absent from the map fall through to
   * the owner's global interactive threshold ({@link defaultTiers}).
   */
  tierOverrides?: Record<string, SlackCapabilityTier>;
  /**
   * The resolved default per room kind for cell-less rows: the winning
   * broader-scope matrix cell for that channel type, else the owner's
   * global interactive threshold. `null` while unknown (loading/error) —
   * rows then show a plain "Default" badge rather than guessing a tier.
   */
  defaultTiers?: Record<SlackRoomKind, SlackCapabilityTier | null>;
  /**
   * True until persisted overrides have loaded — expanded rows hold their
   * tier picker disabled so stored overrides can't be misread as defaults.
   */
  tierOverridesLoading?: boolean;
  /**
   * True when persisted overrides failed to load. The picker stays disabled
   * — writing over unknown stored cells could silently clobber them.
   */
  tierOverridesError?: boolean;
  /** Channels with a tier write in flight — the row shows a saving hint. */
  pendingChannelIds?: ReadonlySet<string>;
  onTierChange?: (channelId: string, tier: SlackCapabilityTier) => void;
  /** Deletes the channel's persisted cells so the default wins again. */
  onTierReset?: (channelId: string) => void;
}

const EMPTY_PENDING_IDS: ReadonlySet<string> = new Set();

/**
 * Presence channel list for the Slack sub-tab: every Slack channel the
 * assistant is a member of, with a per-row resolved-access badge. Rows
 * expand inline (single-open accordion; "Expand all" switches to multi-open)
 * to configure the channel's Assistant Access tier. Search and the kind chips
 * narrow the list client-side; the membership filter itself is server-side
 * (`?memberOnly=true`) with no toggle.
 */
export function SlackChannelList({
  assistantDisplayName,
  slackHandle,
  channels,
  loading = false,
  error = false,
  tierOverrides,
  defaultTiers,
  tierOverridesLoading = false,
  tierOverridesError = false,
  pendingChannelIds = EMPTY_PENDING_IDS,
  onTierChange,
  onTierReset,
}: SlackChannelListProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<SlackRoomKind | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [multiOpen, setMultiOpen] = useState(false);

  // Radix reports the full next open-set; outside "Expand all" mode the
  // single-open rule keeps only the newly opened row.
  const handleOpenChange = (next: string[]) => {
    setOpenIds((prev) => {
      if (multiOpen) {
        return new Set(next);
      }
      const added = next.find((id) => !prev.has(id));
      return added ? new Set([added]) : new Set<string>();
    });
  };

  const toggleExpandAll = () => {
    if (multiOpen) {
      setMultiOpen(false);
      setOpenIds(new Set());
    } else {
      setMultiOpen(true);
      setOpenIds(new Set(allChannels.map((channel) => channel.id)));
    }
  };

  const allChannels = useMemo(() => roomsOnly(channels ?? []), [channels]);
  const visibleChannels = useMemo(
    () => filterSlackChannels(allChannels, search, kindFilter),
    [allChannels, search, kindFilter],
  );
  const kindCounts = useMemo(
    () => countSlackChannelKinds(allChannels),
    [allChannels],
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
    <>
      <Card.Root>
        <Card.Header>
          <div className="flex flex-col gap-1">
            Where {assistantDisplayName} is present
            <Typography
              as="p"
              variant="body-small-default"
              className="text-[color:var(--content-tertiary)]"
            >
              {inviteHint}
            </Typography>
          </div>
        </Card.Header>
        <Card.Body className="flex flex-col gap-3">
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
                <Button type="button" variant="outlined" onClick={toggleExpandAll}>
                  {multiOpen ? "Collapse all" : "Expand all"}
                </Button>
              </div>
              {visibleChannels.length === 0 ? (
                <Typography
                  as="span"
                  variant="body-small-default"
                  className="py-4 text-center text-[color:var(--content-tertiary)]"
                >
                  No channels match.
                </Typography>
              ) : (
                <Collapsible.Root
                  type="multiple"
                  value={[...openIds]}
                  onValueChange={handleOpenChange}
                >
                  {visibleChannels.length > VIRTUALIZE_THRESHOLD ? (
                    // Virtuoso sizes its scroller to 100% of the wrapper, so
                    // the fixed height lives on the wrapper, not the list.
                    <div className="h-96">
                      <VirtualList
                        items={visibleChannels}
                        computeItemKey={(_, channel) => channel.id}
                        itemContent={(_, channel) => (
                          <SlackChannelRow
                            channel={channel}
                            open={openIds.has(channel.id)}
                            pending={pendingChannelIds.has(channel.id)}
                            overridesLoading={tierOverridesLoading}
                            overridesError={tierOverridesError}
                            defaultTiers={defaultTiers}
                            tierOverride={tierOverrides?.[channel.id]}
                            onTierChange={(tier) =>
                              onTierChange?.(channel.id, tier)
                            }
                            onReset={() => onTierReset?.(channel.id)}
                          />
                        )}
                        className="h-full"
                      />
                    </div>
                  ) : (
                    visibleChannels.map((channel) => (
                      <SlackChannelRow
                        key={channel.id}
                        channel={channel}
                        open={openIds.has(channel.id)}
                        pending={pendingChannelIds.has(channel.id)}
                        overridesLoading={tierOverridesLoading}
                        overridesError={tierOverridesError}
                        defaultTiers={defaultTiers}
                        tierOverride={tierOverrides?.[channel.id]}
                        onTierChange={(tier) =>
                          onTierChange?.(channel.id, tier)
                        }
                        onReset={() => onTierReset?.(channel.id)}
                      />
                    ))
                  )}
                </Collapsible.Root>
              )}
            </>
          )}
        </Card.Body>
        {!loading && !error && allChannels.length > 0 ? (
          <Card.Footer>
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
          </Card.Footer>
        ) : null}
      </Card.Root>
      <SlackChannelTierLegend assistantName={assistantDisplayName} />
    </>
  );
}

function SlackChannelRow({
  channel,
  open,
  pending,
  overridesLoading,
  overridesError,
  defaultTiers,
  tierOverride,
  onTierChange,
  onReset,
}: {
  channel: SlackChannel;
  open: boolean;
  pending: boolean;
  overridesLoading: boolean;
  overridesError: boolean;
  defaultTiers: Record<SlackRoomKind, SlackCapabilityTier | null> | undefined;
  tierOverride: SlackCapabilityTier | undefined;
  onTierChange: (tier: SlackCapabilityTier) => void;
  onReset: () => void;
}) {
  const kind = classifySlackChannelKind(channel);
  // Rows are rooms only ({@link roomsOnly}); a 1:1 DM row is unreachable.
  if (kind === "dm") {
    return null;
  }
  const Icon = CHANNEL_KIND_ICONS[kind];
  const metaLabel = slackChannelMetaLabel(channel);
  const settings = resolveChannelTier(tierOverride);
  // No cell → the row shows the resolved fall-through tier for its kind
  // (broader-scope matrix cell, else the owner's global interactive
  // threshold) marked "default", never a hardcoded one.
  const tierMeta =
    settings.tier !== null ? CAPABILITY_TIER_META[settings.tier] : null;
  const defaultTier = defaultTiers?.[kind] ?? null;
  const defaultMeta =
    defaultTier !== null ? CAPABILITY_TIER_META[defaultTier] : null;
  return (
    <Collapsible.Item
      value={channel.id}
      className="[&+&]:border-t [&+&]:border-[var(--border-base)]"
    >
      <Collapsible.Trigger
        aria-label={`${channel.name} — ${open ? "collapse" : "expand"} channel settings`}
        className="group gap-3 rounded-md px-2 py-3 transition-colors hover:bg-[var(--surface-hover)]"
      >
        <Icon
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
        />
        <span className="min-w-0 flex-1 truncate text-left text-body-medium-default text-[var(--content-default)]">
          {channel.name}
        </span>
        <span className="flex shrink-0 items-center gap-4">
          {pending ? (
            <span className="text-body-small-default text-[color:var(--content-tertiary)]">
              Saving…
            </span>
          ) : metaLabel != null ? (
            <span className="text-body-small-default text-[color:var(--content-tertiary)]">
              {metaLabel}
            </span>
          ) : null}
          {tierMeta !== null ? (
            <Tag tone={tierMeta.tone}>{tierMeta.label} • custom</Tag>
          ) : (
            <Tag>
              {defaultMeta !== null
                ? `${defaultMeta.label} • default`
                : "Default"}
            </Tag>
          )}
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-180"
          />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <SlackChannelOverridePanel
          channelName={channel.name}
          settings={settings}
          defaultTier={defaultTier}
          loading={overridesLoading}
          error={overridesError}
          onTierChange={onTierChange}
          onReset={onReset}
        />
      </Collapsible.Content>
    </Collapsible.Item>
  );
}
