import { Typography } from "@vellumai/design-library/components/typography";

import {
  CAPABILITY_TIER_META,
  CHANNEL_TIER_VALUES,
  channelTierBehavesAs,
} from "@/domains/channels/slack-channel-overrides";
import { TierDot } from "@/domains/channels/components/tier-picker";
import type { RiskThreshold } from "@/utils/threshold-presets";

/**
 * One line per level, all on the single lookup-depth axis: how much the
 * assistant does on its own when answering other people before checking with
 * the owner. The per-level lines are the whole key (LUM-2905); the card
 * header carries the Trust Rules pointer.
 *
 * Both lines lead with the ask, so the only thing that differs between levels
 * is the exception clause and the levels stay comparable at a glance.
 *
 * The exception is grounded in what a channel cell can actually delegate
 * (`assistant/src/tools/tool-approval-handler.ts` → `isChannelLiftable`): only
 * non-executing side effects in the assistant's own workspace (reads, public
 * `web_fetch`, and ordinary in-workspace file writes). "Saving files in its
 * own workspace" is the wording the global Conservative preset already uses
 * (`utils/threshold-presets.ts`), so both surfaces name the delegated work the
 * same way; the workspace scope is what keeps it from reading as document
 * authoring, since the document tools run on the host and stay on the
 * capability floor.
 *
 * The capability floor (code, the owner's computer or accounts, unvetted
 * skills always escalate) needs no inventory here: "asks before anything
 * beyond ..." already covers everything the exception does not name.
 */
function tierDescription(tier: RiskThreshold): string {
  return tier === "none"
    ? "Asks before every action, even a web search."
    : "Asks before anything beyond looking things up and saving files in its own workspace.";
}

export interface SlackChannelTierLegendProps {
  /**
   * The level the owner's global setting resolves to, marked "· default" in
   * the key so it lines up with the rows (which name the same level). `null`
   * while unknown; no level is marked.
   */
  defaultTier: RiskThreshold | null;
}

/**
 * Always-visible Assistant Access key in the default-access card footer: only
 * the levels themselves, each name over its {@link tierDescription} line,
 * which carries the full meaning. No heading and no scope line: the rows
 * above the footer already establish what is being picked, and the "applies
 * to other people in the channel" scope fact from #39143 was deliberately
 * traded away for brevity in LUM-2905; restore a scope line here if that
 * confusion resurfaces. Everything renders on screen (no hover tooltip) so
 * the meaning is reachable on touch. The level the global default resolves to
 * is marked "· default", matching the per-row picker so the two read
 * together.
 *
 * The key lists levels most-permissive-first (Conservative before Strict) so
 * the usual default reads first; the picker menu keeps preset order, which is
 * fine because each key entry names its level.
 */
export function SlackChannelTierLegend({ defaultTier }: SlackChannelTierLegendProps) {
  const shownDefault = channelTierBehavesAs(defaultTier ?? undefined) ?? null;
  const legendTiers = [...CHANNEL_TIER_VALUES].reverse();
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {legendTiers.map((tier) => {
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
              {/* body-small-lighter, not -default: these lines wrap, and the
                  -default/-emphasised variants are line-height-1 single-line
                  label styles (tokens.css). */}
              <Typography
                as="span"
                variant="body-small-lighter"
                className="text-[color:var(--content-tertiary)]"
              >
                {tierDescription(tier)}
              </Typography>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
