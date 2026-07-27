import { Link } from "react-router";

import { Typography } from "@vellumai/design-library/components/typography";

import {
  CAPABILITY_TIER_META,
  CHANNEL_TIER_VALUES,
  channelTierBehavesAs,
} from "@/domains/channels/slack-channel-overrides";
import { TierDot } from "@/domains/channels/components/tier-picker";
import type { RiskThreshold } from "@/utils/threshold-presets";
import { routes } from "@/utils/routes";

/**
 * Full per-level help copy, framed around what the assistant does on its own
 * when answering other people in the channel. Rendered inline under each name
 * in the key, so the meaning is on screen without hovering — plain text (not
 * JSX) because it interpolates the assistant name. The terse
 * `CAPABILITY_TIER_META.sublabel` is the picker's short form, not used here.
 *
 * Grounded in what a channel cell can actually delegate
 * (`assistant/src/tools/tool-approval-handler.ts` → `isChannelLiftable`): only
 * non-executing side effects in the assistant's own workspace — reads, public
 * `web_fetch`, and ordinary in-workspace file writes. "Take notes" describes
 * those writes without implying documents: the document tools run on the host
 * and stay on the capability floor. Everything the footer names is floored at
 * every level, so the two levels differ only in whether that narrow set runs
 * on its own or asks first.
 */
function tierDescription(tier: RiskThreshold, assistantName: string): string {
  return tier === "none"
    ? `${assistantName} replies, but asks you before doing anything else, even a web search.`
    : `${assistantName} can look things up and take notes on its own: web searches, public web pages, and reading and writing files in its own workspace.`;
}

export interface SlackChannelTierLegendProps {
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantName: string;
  /**
   * The level the owner's global setting resolves to, marked "· default" in
   * the key so it lines up with the rows (which name the same level). `null`
   * while unknown — no level is marked.
   */
  defaultTier: RiskThreshold | null;
}

/**
 * Always-visible Assistant Access key in the default-access card footer: a
 * heading, who the levels apply to, every level as its name over the full
 * {@link tierDescription} sentence, then the boundary that holds at every
 * level. Everything renders on screen — no hover tooltip — so the meaning is
 * reachable on touch. The level the global default resolves to is marked
 * "· default", matching the per-row picker so the two read together.
 */
export function SlackChannelTierLegend({
  assistantName,
  defaultTier,
}: SlackChannelTierLegendProps) {
  const shownDefault = channelTierBehavesAs(defaultTier ?? undefined) ?? null;
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <Typography as="span" variant="body-small-emphasised">
        Assistant Access levels
      </Typography>
      <Typography
        as="p"
        variant="body-small-default"
        className="text-[color:var(--content-tertiary)]"
      >
        Applies to other people in the channel — your own requests use your
        global Assistant Access.
      </Typography>
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {CHANNEL_TIER_VALUES.map((tier) => {
          const meta = CAPABILITY_TIER_META[tier];
          return (
            <li key={tier} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <TierDot color={meta.dotColor} />
                <Typography as="span" variant="body-small-emphasised">
                  {meta.label}
                </Typography>
                {tier === shownDefault ? (
                  <Typography
                    as="span"
                    variant="body-small-default"
                    className="text-[color:var(--content-tertiary)]"
                  >
                    · default
                  </Typography>
                ) : null}
              </span>
              <Typography
                as="span"
                variant="body-small-default"
                className="text-[color:var(--content-tertiary)]"
              >
                {tierDescription(tier, assistantName)}
              </Typography>
            </li>
          );
        })}
      </ul>
      <Typography
        as="p"
        variant="body-small-default"
        className="text-[color:var(--content-tertiary)]"
      >
        Whatever the level, nothing in this room lets {assistantName} run code,
        change how it works, reach your computer or your connected accounts, or
        use skills you haven&rsquo;t vetted. Those always come to you first.
        Your{" "}
        <Link
          to={routes.settings.privacy}
          className="text-[var(--content-link)] underline hover:text-[var(--content-link-hover)]"
        >
          Trust Rules
        </Link>{" "}
        fine-tune when it asks.
      </Typography>
    </div>
  );
}
