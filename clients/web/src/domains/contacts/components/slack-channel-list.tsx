import { ChevronDown, Hash, Lock, Search, User } from "lucide-react";
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
import { isVerifiedContactChannel } from "@/domains/contacts/components/contact-channels-section";
import { SlackChannelOverridePanel } from "@/domains/contacts/components/slack-channel-override-panel";
import {
  CAPABILITY_TIER_META,
  resolveChannelTier,
  type SlackCapabilityTier,
} from "@/domains/contacts/slack-channel-overrides";
import type { ContactPayload, SlackChannel } from "@/domains/contacts/types";

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
 * Whether a DM row's peer is a verified contact — the contact-trust input
 * to the channel-type defaults. Always false for non-DM rows.
 */
export function isVerifiedSlackDm(
  channel: SlackChannel,
  verifiedDmContactNames: ReadonlySet<string>,
): boolean {
  return (
    classifySlackChannelKind(channel) === "dm" &&
    verifiedDmContactNames.has(normalizeSlackDmName(channel.name))
  );
}

/** Shared timing for the accordion region and the caret rotation. */
const ACCORDION_TRANSITION =
  "duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)]";

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
  /** Channels with a tier write in flight — the row shows a saving hint. */
  pendingChannelIds?: ReadonlySet<string>;
  onTierChange?: (channelId: string, tier: SlackCapabilityTier) => void;
  /** Deletes the channel's persisted cells so the default wins again. */
  onTierReset?: (channelId: string) => void;
}

const EMPTY_VERIFIED_NAMES: ReadonlySet<string> = new Set();
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
  verifiedDmContactNames = EMPTY_VERIFIED_NAMES,
  tierOverrides,
  tierOverridesLoading = false,
  pendingChannelIds = EMPTY_PENDING_IDS,
  onTierChange,
  onTierReset,
}: SlackChannelListProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<SlackChannelKind | null>(null);
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
      setOpenIds(new Set((channels ?? []).map((channel) => channel.id)));
    }
  };

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
                        verifiedDmContactNames={verifiedDmContactNames}
                        open={openIds.has(channel.id)}
                        pending={pendingChannelIds.has(channel.id)}
                        overridesLoading={tierOverridesLoading}
                        onToggle={() => toggleRow(channel.id)}
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
                <div className="flex flex-col">
                  {visibleChannels.map((channel) => (
                    <SlackChannelRow
                      key={channel.id}
                      channel={channel}
                      verifiedDmContactNames={verifiedDmContactNames}
                      open={openIds.has(channel.id)}
                      pending={pendingChannelIds.has(channel.id)}
                      overridesLoading={tierOverridesLoading}
                      onToggle={() => toggleRow(channel.id)}
                      tierOverride={tierOverrides?.[channel.id]}
                      onTierChange={(tier) => onTierChange?.(channel.id, tier)}
                      onReset={() => onTierReset?.(channel.id)}
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
  open,
  pending,
  overridesLoading,
  onToggle,
  tierOverride,
  onTierChange,
  onReset,
}: {
  channel: SlackChannel;
  verifiedDmContactNames: ReadonlySet<string>;
  open: boolean;
  pending: boolean;
  overridesLoading: boolean;
  onToggle: () => void;
  tierOverride: SlackCapabilityTier | undefined;
  onTierChange: (tier: SlackCapabilityTier) => void;
  onReset: () => void;
}) {
  const kind = classifySlackChannelKind(channel);
  const Icon = CHANNEL_KIND_ICONS[kind];
  const metaLabel = slackChannelMetaLabel(channel);
  const dmVerified = isVerifiedSlackDm(channel, verifiedDmContactNames);
  const settings = resolveChannelTier(kind, dmVerified, tierOverride);
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
            kindLabel={kind === "dm" ? "DM" : kind}
            settings={settings}
            loading={overridesLoading}
            onTierChange={onTierChange}
            onReset={onReset}
          />
        </div>
      </div>
    </div>
  );
}
