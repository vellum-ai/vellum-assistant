import { Hash, MessageSquare } from "lucide-react";

import { Card } from "@vellumai/design-library/components/card";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Typography } from "@vellumai/design-library/components/typography";

import { SlackChannelTierLegend } from "@/domains/channels/components/slack-channel-tier-legend";
import { TierPicker } from "@/domains/channels/components/tier-picker";
import type { ChannelDefaultBucket } from "@/domains/channels/slack-channel-overrides";
import type { RiskThreshold } from "@/utils/threshold-presets";

interface BucketRow {
  bucket: ChannelDefaultBucket;
  icon: typeof Hash;
  title: string;
  description: string;
}

/**
 * The two default buckets, in cascade order. "Channels" is the adapter-wide
 * default; "Direct messages" overrides it for DMs. Public and private aren't
 * split — the gateway forwards them identically, so a per-kind default wouldn't
 * take effect.
 */
const BUCKET_ROWS: readonly BucketRow[] = [
  {
    bucket: "channels",
    icon: Hash,
    title: "Channels",
    description: "Public and private channels",
  },
  {
    bucket: "dm",
    icon: MessageSquare,
    title: "Direct messages",
    description: "1:1 and group DMs",
  },
];

export interface SlackChannelTypeDefaultsProps {
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantName: string;
  /**
   * The owner's global Assistant Access default that the "Channels" bucket falls
   * through to when it has no cell. `null` while the global threshold is still
   * unknown. DMs fall through to the "Channels" tier, then to this.
   */
  globalDefaultTier: RiskThreshold | null;
  /** The explicit tier per bucket, or `undefined` when the bucket follows its fall-through. */
  bucketTiers?: Record<ChannelDefaultBucket, RiskThreshold | undefined>;
  loading: boolean;
  error: boolean;
  pendingBuckets: ReadonlySet<ChannelDefaultBucket>;
  onBucketChange: (bucket: ChannelDefaultBucket, tier: RiskThreshold) => void;
  onBucketReset: (bucket: ChannelDefaultBucket) => void;
}

/**
 * Primary "Default access" card for the Slack sub-tab: two rows mapping a
 * conversation type (Channels, Direct messages) to its default Assistant Access
 * level, with the always-visible tier key in the footer. Each row's picker names
 * the effective level and marks the one it inherits, exactly like the per-room
 * picker ({@link TierPicker}). Individual channels override these below.
 */
export function SlackChannelTypeDefaults({
  assistantName,
  globalDefaultTier,
  bucketTiers,
  loading,
  error,
  pendingBuckets,
  onBucketChange,
  onBucketReset,
}: SlackChannelTypeDefaultsProps) {
  return (
    <Card.Root>
      <Card.Header>
        <div className="flex flex-col gap-1">
          Default access
          <Typography
            as="p"
            variant="body-small-default"
            className="text-[color:var(--content-tertiary)]"
          >
            How much {assistantName} does on its own, by conversation type.
            Individual channels can override this below.
          </Typography>
        </div>
      </Card.Header>
      <Card.Body>
        {BUCKET_ROWS.map(({ bucket, icon: Icon, title, description }) => {
          // DMs fall through to the Channels default, then the global default;
          // Channels falls through to the global default.
          const inheritedTier =
            bucket === "dm"
              ? (bucketTiers?.channels ?? globalDefaultTier)
              : globalDefaultTier;
          return (
            <ListRow
              key={bucket}
              className="[&+&]:border-t [&+&]:border-[var(--border-base)]"
              leading={<Icon className="h-4 w-4 text-[var(--content-tertiary)]" />}
              title={title}
              subtitle={description}
              trailing={
                <div className="w-48">
                  <TierPicker
                    tier={bucketTiers?.[bucket]}
                    defaultTier={inheritedTier}
                    disabled={loading || error || pendingBuckets.has(bucket)}
                    onTierChange={(tier) => onBucketChange(bucket, tier)}
                    onReset={() => onBucketReset(bucket)}
                    aria-label={`Default Assistant Access for ${title}`}
                  />
                </div>
              }
            />
          );
        })}
      </Card.Body>
      <Card.Footer className="p-0">
        <SlackChannelTierLegend
          assistantName={assistantName}
          defaultTier={globalDefaultTier}
        />
      </Card.Footer>
    </Card.Root>
  );
}
