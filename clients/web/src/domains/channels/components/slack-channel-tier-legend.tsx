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
 * One line per level, all on the single lookup-depth axis: how much the
 * assistant does on its own when answering other people before checking with
 * the owner. The per-level lines carry the whole explanation (LUM-2905) — the
 * line above them only says who the levels apply to.
 *
 * Grounded in what a channel cell can actually delegate
 * (`assistant/src/tools/tool-approval-handler.ts` → `isChannelLiftable`): only
 * non-executing side effects in the assistant's own workspace — reads, public
 * `web_fetch`, and ordinary in-workspace file writes. "Takes notes" describes
 * those writes without implying documents: the document tools run on the host
 * and stay on the capability floor.
 *
 * The capability floor (code, the owner's computer or accounts, unvetted
 * skills always escalate) compresses to "asks first for anything bigger" —
 * accurate without the inventory, and it keeps the two lines the same weight:
 * both name what runs on its own, then that everything else asks.
 */
function tierDescription(tier: RiskThreshold): string {
  return tier === "none"
    ? "Replies, but asks first for anything else, even a web search."
    : "Looks things up and takes notes on its own; asks first for anything bigger.";
}

export interface SlackChannelTierLegendProps {
  /**
   * The level the owner's global setting resolves to, marked "· default" in
   * the key so it lines up with the rows (which name the same level). `null`
   * while unknown — no level is marked.
   */
  defaultTier: RiskThreshold | null;
}

/**
 * Always-visible Assistant Access key in the default-access card footer: the
 * levels themselves — each name over its {@link tierDescription} line, which
 * carries the full meaning — then one line of scope (who the levels apply to,
 * plus the Trust Rules link). No heading: the rows above the footer already
 * establish what is being picked. Everything renders on screen — no hover
 * tooltip — so the meaning is reachable on touch; the copy stays terse so the
 * key scans (LUM-2905). The level the global default resolves to is marked
 * "· default", matching the per-row picker so the two read together.
 */
export function SlackChannelTierLegend({ defaultTier }: SlackChannelTierLegendProps) {
  const shownDefault = channelTierBehavesAs(defaultTier ?? undefined) ?? null;
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
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
                {tierDescription(tier)}
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
        For other people in the channel — you keep your global setting.{" "}
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
