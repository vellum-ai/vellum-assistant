/**
 * Per-channel capabilities-tier model for the Slack channel list's
 * expandable rows. Capabilities is the only per-room knob, and the list is
 * rooms only (channels and group DMs): admission — who can reach the
 * assistant — is a channel-type concern handled by the trust floors, and
 * how the assistant interacts with an individual person is contact-list
 * territory, so 1:1 DMs carry no room settings.
 *
 * Tiers persist as channel-ID-tier cells in the gateway's
 * `channel_permission_overrides` matrix (one cell per non-guardian
 * contact-type; see {@link CHANNEL_TIER_CONTACT_TYPES}).
 */
import type { TagTone } from "@vellumai/design-library/components/tag";

import {
  presetFromThreshold,
  type RiskThreshold,
} from "@/utils/threshold-presets";

/**
 * Three-level capabilities tier shown on the row badge and the segmented
 * picker. `strict` and `full_access` carry the same labels as the matching
 * threshold presets; `standard` is the tier axis's intermediate level.
 */
export const CAPABILITY_TIER_VALUES = [
  "strict",
  "standard",
  "full_access",
] as const;

export type SlackCapabilityTier = (typeof CAPABILITY_TIER_VALUES)[number];

interface CapabilityTierMeta {
  label: string;
  /** Short qualifier shown with the tier in pickers and help copy. */
  sublabel: string;
  /** One-line help text for the selected tier. */
  description: string;
  tone: TagTone;
}

export const CAPABILITY_TIER_META: Record<SlackCapabilityTier, CapabilityTierMeta> = {
  strict: {
    label: presetFromThreshold("none").label,
    sublabel: "ask before every action",
    description:
      "Nothing is auto-approved — every tool call from this channel asks first.",
    tone: "negative",
  },
  standard: {
    label: "Standard",
    sublabel: "reply + safe tools",
    description:
      "Safe, low-risk tools are auto-approved; anything sensitive still asks.",
    tone: "warning",
  },
  full_access: {
    label: presetFromThreshold("high").label,
    sublabel: "all tools",
    description:
      "All tools auto-approve in this channel, even when the global setting is stricter. Sensitive-tool protections still apply.",
    tone: "positive",
  },
};

/** Threshold written to each contact-type cell when a tier is chosen. */
export const CAPABILITY_TIER_THRESHOLDS: Record<
  SlackCapabilityTier,
  RiskThreshold
> = {
  strict: "none",
  standard: "low",
  full_access: "high",
};

/**
 * Inverse presentation mapping for cells written elsewhere: "medium"
 * (Relaxed — no tier equivalent) reads as the intermediate tier.
 */
export function tierFromThreshold(
  threshold: RiskThreshold,
): SlackCapabilityTier {
  if (threshold === "none") {
    return "strict";
  }
  if (threshold === "high") {
    return "full_access";
  }
  return "standard";
}

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
 * Channel-ID-tier cells → per-channel tier map for one adapter. The
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
      overrides[channelId] = tierFromThreshold(cell.threshold);
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
export const DEFAULT_CHANNEL_TIER: SlackCapabilityTier = "full_access";

/** Resolves the row's tier from a persisted cell, if any. */
export function resolveChannelTier(
  override: SlackCapabilityTier | undefined,
): SlackChannelTierSettings {
  return {
    tier: override ?? DEFAULT_CHANNEL_TIER,
    overridden: override !== undefined,
  };
}
