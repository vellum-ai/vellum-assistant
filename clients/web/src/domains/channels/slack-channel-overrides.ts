/**
 * Per-channel Assistant Access model for the Slack channel list's
 * expandable rows. The tier is the only per-room knob, and the list is
 * rooms only (channels and group DMs): admission — who can reach the
 * assistant — is a channel-type concern handled by the trust floors, and
 * how the assistant interacts with an individual person is contact-list
 * territory, so 1:1 DMs carry no room settings.
 *
 * The tier axis is not its own vocabulary: a channel tier IS a
 * {@link RiskThreshold}, the same value the global Assistant Access
 * presets ({@link THRESHOLD_PRESETS}) read and write, and it carries the
 * same preset name everywhere it appears. This module adds only the
 * channel-surface presentation (picker sublabels, badge tones).
 *
 * Tiers persist as channel-ID cells in the gateway's
 * `channel_permission_overrides` matrix (one cell per non-guardian
 * contact-type; see {@link CHANNEL_TIER_CONTACT_TYPES}).
 */
import type { TagTone } from "@vellumai/design-library/components/tag";

import {
  presetFromThreshold,
  THRESHOLD_PRESETS,
  type RiskThreshold,
} from "@/utils/threshold-presets";

/** Picker/legend order: the global presets' own order (Strict → Full access). */
export const CAPABILITY_TIER_VALUES: readonly RiskThreshold[] =
  THRESHOLD_PRESETS.map((preset) => preset.riskThreshold);

interface CapabilityTierMeta {
  /** Preset name, straight from the matching global Assistant Access preset. */
  label: string;
  /**
   * Short qualifier shown beside the label in the picker and the legend key.
   * Frames how much the assistant does on its own before checking with the
   * owner — reads/answers only, since writes/sends/spends always escalate. The
   * full per-tier sentence lives in the legend (`SlackChannelTierLegend`); it
   * interpolates the assistant name, so it can't be a static string here.
   */
  sublabel: string;
  tone: TagTone;
  /**
   * Accent dot color for this tier, the single source shared by the per-row
   * picker and the legend key so the two can't drift. Mirrors the tone's Tag
   * accent (`--system-*-strong`).
   */
  dotColor: string;
}

export const CAPABILITY_TIER_META: Record<RiskThreshold, CapabilityTierMeta> = {
  none: {
    label: presetFromThreshold("none").label,
    sublabel: "asks before acting",
    tone: "negative",
    dotColor: "var(--system-negative-strong)",
  },
  low: {
    label: presetFromThreshold("low").label,
    sublabel: "safe reads only",
    tone: "warning",
    dotColor: "var(--system-mid-strong)",
  },
  medium: {
    label: presetFromThreshold("medium").label,
    sublabel: "broader lookups",
    tone: "info",
    dotColor: "var(--system-info-strong)",
  },
  high: {
    label: presetFromThreshold("high").label,
    sublabel: "answers on its own",
    tone: "positive",
    dotColor: "var(--system-positive-strong)",
  },
};

/**
 * Contact types a channel-tier write fans out to: everyone except the
 * guardian — room-level posture never restricts the guardian (same rule as
 * the m0012 Slack-profile migration).
 */
export const CHANNEL_TIER_CONTACT_TYPES = [
  "trusted_contact",
  "unverified_contact",
  "unknown",
] as const;

/**
 * Structural view of a matrix cell as the generated gateway SDK returns it —
 * kept structural so this module stays free of generated-type imports.
 */
export interface ChannelTierCell {
  selector: {
    scope: string;
    adapter?: string;
    channelExternalId?: string;
    channelType?: string;
  };
  contactType: string;
  threshold: RiskThreshold;
}

/**
 * Channel-ID cells → per-channel tier map for one adapter. The
 * trusted_contact cell is the representative when contact-type cells
 * diverge (the write path keeps all non-guardian cells aligned).
 */
export function tierOverridesFromCells(
  cells: ChannelTierCell[],
  adapter: string,
): Record<string, RiskThreshold> {
  const overrides: Record<string, RiskThreshold> = {};
  for (const cell of cells) {
    if (
      cell.selector.scope !== "channel" ||
      cell.selector.adapter !== adapter
    ) {
      continue;
    }
    const channelId = cell.selector.channelExternalId;
    if (!channelId) {
      continue;
    }
    if (cell.contactType === "trusted_contact" || !(channelId in overrides)) {
      overrides[channelId] = cell.threshold;
    }
  }
  return overrides;
}

/**
 * The two broader-scope default "buckets" the channel-type UI exposes:
 * `"channels"` writes an `adapter`-scope cell (the default for every room of
 * this adapter), `"dm"` writes a `channel_type: dm` cell (the default for direct
 * messages, which overrides the adapter default for DMs). Public/private are not
 * split — the gateway forwards Slack public and private rooms identically, so a
 * `channel_type: public|private` cell would never match at tool time.
 */
export type ChannelDefaultBucket = "channels" | "dm";

/**
 * The persisted tier for a bucket's cell, if any — the `trusted_contact` cell is
 * the representative when non-guardian contact-type cells diverge (the write
 * path keeps them aligned). `undefined` when the bucket has no cell (it then
 * follows the next tier up the cascade).
 */
export function bucketDefaultFromCells(
  cells: ChannelTierCell[],
  adapter: string,
  bucket: ChannelDefaultBucket,
): RiskThreshold | undefined {
  let tier: RiskThreshold | undefined;
  for (const cell of cells) {
    const matches =
      bucket === "channels"
        ? cell.selector.scope === "adapter" && cell.selector.adapter === adapter
        : cell.selector.scope === "channel_type" &&
          cell.selector.adapter === adapter &&
          cell.selector.channelType === "dm";
    if (!matches) {
      continue;
    }
    if (cell.contactType === "trusted_contact" || tier === undefined) {
      tier = cell.threshold;
    }
  }
  return tier;
}
