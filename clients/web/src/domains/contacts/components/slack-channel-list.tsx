import { ChevronDown, Hash, Lock, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";
import { VirtualList } from "@vellumai/design-library/components/virtual-list";

import { EmptyState } from "@/components/empty-state";
import { SlackChannelOverridePanel } from "@/domains/contacts/components/slack-channel-override-panel";
import {
  CAPABILITY_TIER_META,
  resolveChannelTier,
  type SlackCapabilityTier,
} from "@/domains/contacts/slack-channel-overrides";
import type { SlackChannel } from "@/domains/contacts/types";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";

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

/** Shared timing for the accordion region and the caret rotation. */
const ACCORDION_TRANSITION =
  "duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)]";

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
   * channel-permission cells). Channels absent from the map use the
   * channel-type default.
   */
  tierOverrides?: Record<string, SlackCapabilityTier>;
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
  /** Slack trust floor, shown read-only in expanded rows. */
  admissionPolicy?: AdmissionPolicy;
}

const EMPTY_PENDING_IDS: ReadonlySet<string> = new Set();

/**
 * Presence channel list for the Slack sub-tab: every Slack channel the
 * assistant is a member of, with a per-row resolved-access badge. Rows
 * expand inline (single-open accordion; "Expand all" switches to multi-open)
 * to configure the channel's two override axes. Search and the kind chips
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
  tierOverridesLoading = false,
  tierOverridesError = false,
  pendingChannelIds = EMPTY_PENDING_IDS,
  onTierChange,
  onTierReset,
  admissionPolicy,
}: SlackChannelListProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<SlackRoomKind | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [multiOpen, setMultiOpen] = useState(false);

  const toggleRow = (id: string) => {
    setOpenIds((prev) => {
      if (multiOpen) {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      }
      return prev.has(id) ? new Set() : new Set([id]);
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
                        open={openIds.has(channel.id)}
                        pending={pendingChannelIds.has(channel.id)}
                        overridesLoading={tierOverridesLoading}
                        overridesError={tierOverridesError}
                        onToggle={() => toggleRow(channel.id)}
                        tierOverride={tierOverrides?.[channel.id]}
                        onTierChange={(tier) =>
                          onTierChange?.(channel.id, tier)
                        }
                        onReset={() => onTierReset?.(channel.id)}
                        assistantDisplayName={assistantDisplayName}
                        admissionPolicy={admissionPolicy}
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
                      open={openIds.has(channel.id)}
                      pending={pendingChannelIds.has(channel.id)}
                      overridesLoading={tierOverridesLoading}
                      overridesError={tierOverridesError}
                      onToggle={() => toggleRow(channel.id)}
                      tierOverride={tierOverrides?.[channel.id]}
                      onTierChange={(tier) => onTierChange?.(channel.id, tier)}
                      onReset={() => onTierReset?.(channel.id)}
                      assistantDisplayName={assistantDisplayName}
                      admissionPolicy={admissionPolicy}
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
  open,
  pending,
  overridesLoading,
  overridesError,
  onToggle,
  tierOverride,
  onTierChange,
  onReset,
  assistantDisplayName,
  admissionPolicy,
}: {
  channel: SlackChannel;
  open: boolean;
  pending: boolean;
  overridesLoading: boolean;
  overridesError: boolean;
  onToggle: () => void;
  tierOverride: SlackCapabilityTier | undefined;
  onTierChange: (tier: SlackCapabilityTier) => void;
  onReset: () => void;
  assistantDisplayName: string;
  admissionPolicy: AdmissionPolicy | undefined;
}) {
  const kind = classifySlackChannelKind(channel);
  // Rows are rooms only ({@link roomsOnly}); a 1:1 DM row is unreachable.
  if (kind === "dm") {
    return null;
  }
  const Icon = CHANNEL_KIND_ICONS[kind];
  const metaLabel = slackChannelMetaLabel(channel);
  const settings = resolveChannelTier(tierOverride);
  const tierMeta = CAPABILITY_TIER_META[settings.tier];
  return (
    <div className="[&+&]:border-t [&+&]:border-[var(--border-base)]">
      <ListRow
        leading={<Icon className="h-4 w-4 text-[var(--content-tertiary)]" />}
        title={channel.name}
        onClick={onToggle}
        contentAriaLabel={`${channel.name} — ${open ? "collapse" : "expand"} channel settings`}
        showChevron={false}
        selected={open}
        className={
          open ? "shadow-[inset_3px_0_0_0_var(--content-default)]" : undefined
        }
        trailing={
          <>
            {pending ? (
              <span className="text-body-small-default text-[color:var(--content-tertiary)]">
                Saving…
              </span>
            ) : metaLabel != null ? (
              <span className="text-body-small-default text-[color:var(--content-tertiary)]">
                {metaLabel}
              </span>
            ) : null}
            <Tag tone={tierMeta.tone}>
              {tierMeta.label}
              {settings.overridden ? " • custom" : ""}
            </Tag>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-4 w-4 text-[var(--content-tertiary)] transition-transform",
                ACCORDION_TRANSITION,
                open && "rotate-180",
              )}
            />
          </>
        }
      />
      <div
        className={cn(
          "grid transition-[grid-template-rows]",
          ACCORDION_TRANSITION,
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <SlackChannelOverridePanel
            channelName={channel.name}
            kindLabel={kind}
            assistantDisplayName={assistantDisplayName}
            admissionPolicy={admissionPolicy}
            settings={settings}
            loading={overridesLoading}
            error={overridesError}
            onTierChange={onTierChange}
            onReset={onReset}
          />
        </div>
      </div>
    </div>
  );
}
