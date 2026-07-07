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

/**
 * A channel's Assistant Access tier — the persisted risk threshold itself,
 * not a parallel enum.
 */
export type SlackCapabilityTier = RiskThreshold;

/** Picker/legend order: the global presets' own order (Strict → Full access). */
export const CAPABILITY_TIER_VALUES: readonly SlackCapabilityTier[] =
  THRESHOLD_PRESETS.map((preset) => preset.riskThreshold);

interface CapabilityTierMeta {
  /** Preset name, straight from the matching global Assistant Access preset. */
  label: string;
  /**
   * Short qualifier shown under the label in the tier picker. The full
   * per-tier description lives in the one-time legend
   * (`SlackChannelTierLegend`) — it needs the assistant name and a settings
   * link, so it can't be a static string here.
   */
  sublabel: string;
  tone: TagTone;
}

export const CAPABILITY_TIER_META: Record<SlackCapabilityTier, CapabilityTierMeta> = {
  none: {
    label: presetFromThreshold("none").label,
    sublabel: "ask before every action",
    tone: "negative",
  },
  low: {
    label: presetFromThreshold("low").label,
    sublabel: "safe actions, ask for the rest",
    tone: "warning",
  },
  medium: {
    label: presetFromThreshold("medium").label,
    sublabel: "workspace actions too",
    tone: "info",
  },
  high: {
    label: presetFromThreshold("high").label,
    sublabel: "acts freely",
    tone: "positive",
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
): Record<string, SlackCapabilityTier> {
  const overrides: Record<string, SlackCapabilityTier> = {};
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

/** The row's resolved tier plus whether a persisted cell backs it. */
export interface SlackChannelTierSettings {
  tier: SlackCapabilityTier;
  /**
   * True when a persisted cell backs the tier. A cell is an override by
   * existing: it pins the channel above the global auto-approve cascade
   * even when its tier matches the room default, so it must stay visible
   * (badge, callout, reset). Without a cell the runtime falls through to
   * the global setting.
   */
  overridden: boolean;
}

/** Presentation default for rooms with no persisted cell. */
export const DEFAULT_CHANNEL_TIER: SlackCapabilityTier = "high";

/** Resolves the row's tier from a persisted cell, if any. */
export function resolveChannelTier(
  override: SlackCapabilityTier | undefined,
): SlackChannelTierSettings {
  return {
    tier: override ?? DEFAULT_CHANNEL_TIER,
    overridden: override !== undefined,
  };
}
