import type { ReactNode } from "react";
import { Link } from "react-router";

import type { TagTone } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  CAPABILITY_TIER_META,
  CAPABILITY_TIER_VALUES,
  type SlackCapabilityTier,
} from "@/domains/contacts/slack-channel-overrides";
import { routes } from "@/utils/routes";

/** Dot accent per tier tone — mirrors the Tag component's icon accents. */
const TONE_DOT_COLOR: Record<TagTone, string> = {
  positive: "var(--system-positive-strong)",
  negative: "var(--system-negative-strong)",
  warning: "var(--system-mid-strong)",
  neutral: "var(--content-secondary)",
};

/**
 * Per-tier help copy, framed around behavior toward the people in the
 * channel: who the assistant can respond to, and what it may run when
 * responding. Lives here rather than in `CAPABILITY_TIER_META` because it
 * interpolates the assistant's name and (for full access) links out to the
 * Privacy settings page.
 */
function tierDescription(
  tier: SlackCapabilityTier,
  assistantName: string,
): ReactNode {
  switch (tier) {
    case "strict":
      return (
        <>
          {assistantName} can respond to messages in this channel, but won’t
          run tools or take actions when doing so.
        </>
      );
    case "standard":
      return (
        <>
          {assistantName} can respond to messages in this channel and run
          safe, read-only tools when doing so. Anything that writes, sends, or
          spends waits for your approval.
        </>
      );
    case "full_access":
      return (
        <>
          {assistantName} can respond to messages in this channel and run any
          tool it has access to when doing so. Your{" "}
          <Link
            to={routes.settings.privacy}
            className="text-[var(--content-link)] underline hover:text-[var(--content-link-hover)]"
          >
            Trust Rules and Risk Tolerance
          </Link>{" "}
          still apply.
        </>
      );
  }
}

export interface SlackChannelTierLegendProps {
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantName: string;
}

/**
 * One-time Assistant Access legend above the channel rows: all three tiers
 * with their behavior descriptions, so the expanded rows don't repeat the
 * same paragraph per channel.
 */
export function SlackChannelTierLegend({
  assistantName,
}: SlackChannelTierLegendProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-[var(--surface-active)] p-4">
      <Typography
        as="h4"
        variant="label-small-default"
        className="uppercase tracking-wider text-[color:var(--content-tertiary)]"
      >
        Assistant Access levels
      </Typography>
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
        {CAPABILITY_TIER_VALUES.map((tier) => {
          const meta = CAPABILITY_TIER_META[tier];
          return (
            <div key={tier} className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: TONE_DOT_COLOR[meta.tone] }}
                />
                <Typography as="span" variant="body-small-emphasised">
                  {meta.label}
                </Typography>
              </span>
              <Typography
                as="p"
                variant="body-small-default"
                className="text-[color:var(--content-tertiary)]"
              >
                {tierDescription(tier, assistantName)}
              </Typography>
            </div>
          );
        })}
      </div>
    </div>
  );
}
