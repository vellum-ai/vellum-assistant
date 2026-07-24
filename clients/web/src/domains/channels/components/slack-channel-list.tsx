import { Hash, Lock, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@vellumai/design-library";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Typography } from "@vellumai/design-library/components/typography";
import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import { EmptyState } from "@/components/empty-state";
import { SlackChannelTierLegend } from "@/domains/channels/components/slack-channel-tier-legend";
import { TierPicker } from "@/domains/channels/components/tier-picker";
import type { RiskThreshold } from "@/utils/threshold-presets";
import type { SlackChannel } from "@/domains/channels/slack-channels-query";

/**
 * How a channel presents in the filter chips. Mirrors the conversation-type
 * axis of the channel-permission matrix (`ChannelConversationType` in
 * `packages/gateway-client/src/channel-permission-contract.ts`). Mutually
 * exclusive: DMs are 1:1 conversations, everything else splits on
 * `isPrivate` (group DMs and legacy private groups count as private).
 */
export type SlackChannelKind = "public" | "private" | "dm";

export function classifySlackChannelKind(
  channel: SlackChannel,
): SlackChannelKind {
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
   * the owner's global interactive threshold ({@link defaultTier}).
   */
  tierOverrides?: Record<string, RiskThreshold>;
  /**
   * The resolved default for cell-less rows: the gateway-resolved
   * broader-scope cell, else the owner's global interactive threshold.
   * `null` while unknown (loading/error) — rows then show a plain
   * "Default" badge rather than guessing a tier.
   */
  defaultTier?: RiskThreshold | null;
  /**
   * False when the connected assistant predates the channel-permission
   * routes: rows render without tier badges or pickers and the legend
   * card is hidden (see `lib/backwards-compat/channel-access-controls.ts`).
   */
  accessControlsSupported?: boolean;
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
  onTierChange?: (channelId: string, tier: RiskThreshold) => void;
  /** Deletes the channel's persisted cells so the default wins again. */
  onTierReset?: (channelId: string) => void;
  /**
   * Whether to render the "Assistant Access levels" key in the footer. Off when
   * the list sits under a primary card that already shows the key (the Slack
   * sub-tab's default-access card). Defaults to on for standalone use.
   */
  showLegend?: boolean;
}

const EMPTY_PENDING_IDS: ReadonlySet<string> = new Set();

/**
 * Presence channel list for the Slack sub-tab: every Slack channel the
 * assistant is a member of, each with an inline Assistant Access picker
 * ({@link TierPicker}) that names the effective level and marks the one it
 * inherits. Search and the kind chips narrow the list client-side; the
 * membership filter itself is server-side (`?memberOnly=true`) with no toggle.
 * The key sits in the footer unless {@link SlackChannelListProps.showLegend} is
 * off (the default-access card owns it in the composed section).
 */
export function SlackChannelList({
  assistantDisplayName,
  slackHandle,
  channels,
  loading = false,
  error = false,
  tierOverrides,
  defaultTier = null,
  accessControlsSupported = true,
  tierOverridesLoading = false,
  tierOverridesError = false,
  pendingChannelIds = EMPTY_PENDING_IDS,
  onTierChange,
  onTierReset,
  showLegend = true,
}: SlackChannelListProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<SlackRoomKind | null>(null);

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
  const presenceHint = (
    <>
      Add with{" "}
      <code className="text-[color:var(--content-secondary)]">
        /invite {handle}
      </code>{" "}
      or remove with{" "}
      <code className="text-[color:var(--content-secondary)]">
        /remove {handle}
      </code>{" "}
      in that Slack channel. Only channels {assistantDisplayName} is in appear
      here.
    </>
  );

  return (
    <>
      <Card.Root className="flex min-h-0 flex-1 flex-col">
        <Card.Header>
          <div className="flex flex-col gap-1">
            Where {assistantDisplayName} is present
            <Typography
              as="p"
              variant="body-small-default"
              className="text-[color:var(--content-tertiary)]"
            >
              {presenceHint}
            </Typography>
          </div>
        </Card.Header>
        <Card.Body className="flex min-h-0 flex-1 flex-col gap-3">
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
              ) : (
                visibleChannels.length > VIRTUALIZE_THRESHOLD ? (
                  // Virtuoso sizes its scroller to 100% of the wrapper, so the
                  // wrapper fills the card's flex scroll area.
                  <div className="min-h-0 flex-1">
                    <VirtualList
                      items={visibleChannels}
                      computeItemKey={(_, channel) => channel.id}
                      itemContent={(_, channel) => (
                        <SlackChannelRow
                          channel={channel}
                          pending={pendingChannelIds.has(channel.id)}
                          overridesLoading={tierOverridesLoading}
                          overridesError={tierOverridesError}
                          defaultTier={defaultTier}
                          accessControls={accessControlsSupported}
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
                  // Rows scroll within the card's flex area; the always-visible
                  // Assistant Access levels key stays pinned in the footer.
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {visibleChannels.map((channel) => (
                      <SlackChannelRow
                        key={channel.id}
                        channel={channel}
                        pending={pendingChannelIds.has(channel.id)}
                        overridesLoading={tierOverridesLoading}
                        overridesError={tierOverridesError}
                        defaultTier={defaultTier}
                        accessControls={accessControlsSupported}
                        tierOverride={tierOverrides?.[channel.id]}
                        onTierChange={(tier) => onTierChange?.(channel.id, tier)}
                        onReset={() => onTierReset?.(channel.id)}
                      />
                    ))}
                  </div>
                )
              )}
            </>
          )}
        </Card.Body>
        {showLegend &&
        accessControlsSupported &&
        !loading &&
        !error &&
        allChannels.length > 0 ? (
          <Card.Footer className="p-0">
            <SlackChannelTierLegend
              assistantName={assistantDisplayName}
              defaultTier={defaultTier}
            />
          </Card.Footer>
        ) : null}
      </Card.Root>
    </>
  );
}

function SlackChannelRow({
  channel,
  pending,
  overridesLoading,
  overridesError,
  defaultTier,
  accessControls,
  tierOverride,
  onTierChange,
  onReset,
}: {
  channel: SlackChannel;
  pending: boolean;
  overridesLoading: boolean;
  overridesError: boolean;
  defaultTier: RiskThreshold | null;
  accessControls: boolean;
  tierOverride: RiskThreshold | undefined;
  onTierChange: (tier: RiskThreshold) => void;
  onReset: () => void;
}) {
  const kind = classifySlackChannelKind(channel);
  // Rows are rooms only ({@link roomsOnly}); a 1:1 DM row is unreachable.
  if (kind === "dm") {
    return null;
  }
  const Icon = CHANNEL_KIND_ICONS[kind];
  const metaLabel = slackChannelMetaLabel(channel);
  const rowClassName = "[&+&]:border-t [&+&]:border-[var(--border-base)]";

  // Older assistant without the channel-permission routes: a plain presence
  // row — no picker, nothing to configure.
  if (!accessControls) {
    return (
      <ListRow
        className={rowClassName}
        leading={<Icon className="h-4 w-4 text-[var(--content-tertiary)]" />}
        title={channel.name}
        trailing={
          metaLabel != null ? (
            <span className="text-body-small-default text-[color:var(--content-tertiary)]">
              {metaLabel}
            </span>
          ) : undefined
        }
      />
    );
  }

  // Per-channel override: the shared picker names the effective level and marks
  // the one that follows the resolved default (see {@link TierPicker}).
  return (
    <ListRow
      className={rowClassName}
      leading={<Icon className="h-4 w-4 text-[var(--content-tertiary)]" />}
      title={channel.name}
      trailing={
        <>
          {metaLabel != null ? (
            <span className="text-body-small-default text-[color:var(--content-tertiary)]">
              {metaLabel}
            </span>
          ) : null}
          <div className="w-48">
            <TierPicker
              tier={tierOverride}
              defaultTier={defaultTier}
              disabled={pending || overridesLoading || overridesError}
              onTierChange={onTierChange}
              onReset={onReset}
              aria-label={`Assistant Access in ${channel.name}`}
            />
          </div>
        </>
      }
    />
  );
}
