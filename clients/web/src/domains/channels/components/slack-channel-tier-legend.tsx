import { Link } from "react-router";

import { Typography } from "@vellumai/design-library/components/typography";

import {
  CAPABILITY_TIER_META,
  CAPABILITY_TIER_VALUES,
} from "@/domains/channels/slack-channel-overrides";
import { TierDot } from "@/domains/channels/components/tier-picker";
import type { RiskThreshold } from "@/utils/threshold-presets";
import { routes } from "@/utils/routes";

/**
 * Full per-tier help copy, framed around behavior toward the people in the
 * channel: what the assistant does on its own when responding, and what waits
 * for the owner. Kept as plain text (not JSX) so it can ride each key entry's
 * hover tooltip — the terse `CAPABILITY_TIER_META` sublabel is what shows
 * inline, the full sentence appears on hover.
 *
 * Grounded in the live approval pipeline
 * (`assistant/src/permissions/checker.ts` → `approval-policy.ts`): each call's
 * risk is classified first — with the user's Trust Rules applied as per-action
 * risk re-classifications (low/medium/high) — and then compared against this
 * channel's tier. At `none` nothing is within threshold, so every action
 * prompts; Trust Rules move an action between levels (changing when it asks)
 * but cannot bypass Strict or hard-block at Full access, which is why the
 * description frames them as tuning, not overriding.
 *
 * Channel actors are non-guardians, so the sensitive-tool floor applies on top
 * of the tier: every side-effect tool (file writes, bash, web fetches —
 * `assistant/src/tools/side-effects.ts`) plus all host execution — the MCP and
 * bundled-skill tools, which is where sends and spends live (messaging, phone
 * calls) — escalates to the owner without a scoped grant, at every tier
 * (`assistant/src/tools/tool-approval-handler.ts`). So the tier only moves the
 * line for the read/lookup tools the assistant runs on its own; every action
 * keeps coming to the owner. This copy is therefore intentionally narrower than
 * the global preset descriptions in `threshold-presets.ts`, which describe the
 * guardian's own conversations where the floor self-approves.
 */
function tierDescription(tier: RiskThreshold, assistantName: string): string {
  switch (tier) {
    case "none":
      return `${assistantName} replies in this channel, but asks you before taking any action.`;
    case "low":
      return `${assistantName} replies and runs safe, read-only actions on its own, like web searches and reading files in its workspace. Anything that writes, sends, or spends asks you first.`;
    case "medium":
      return `${assistantName} reads and looks up more widely on its own, beyond the safe basics. Anything that writes, sends, or spends still asks you first.`;
    case "high":
      return `${assistantName} answers any request on its own without asking. Tools that take action — writing, sending, spending — still come to you first.`;
  }
}

export interface SlackChannelTierLegendProps {
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantName: string;
  /**
   * The tier the owner's global setting resolves to, marked "· default" in the
   * key so it lines up with the rows (which name the same tier). `null` while
   * unknown — no tier is marked.
   */
  defaultTier: RiskThreshold | null;
}

/**
 * Always-visible Assistant Access key in the default-access card footer: a
 * heading, a one-line description of what the levels do (and what always
 * escalates), then every tier as a compact "label + what it does" pair in a
 * two-column grid, so the meaning is on screen without opening anything. The
 * terse sublabel shows inline (the touch-reachable case); the full behavior
 * sentence rides each pair's hover/description `title` as progressive
 * enhancement. The tier the global default resolves to is marked "· default",
 * matching the per-row picker so the two read together.
 */
export function SlackChannelTierLegend({
  assistantName,
  defaultTier,
}: SlackChannelTierLegendProps) {
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
        These levels only cover how much it looks up on its own before answering.
        Writing, sending, and spending always ask first — at every level. Your{" "}
        <Link
          to={routes.settings.privacy}
          className="text-[var(--content-link)] underline hover:text-[var(--content-link-hover)]"
        >
          Trust Rules
        </Link>{" "}
        fine-tune when it asks.
      </Typography>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {CAPABILITY_TIER_VALUES.map((tier) => {
          const meta = CAPABILITY_TIER_META[tier];
          return (
            <li
              key={tier}
              className="flex items-center gap-1.5"
              title={tierDescription(tier, assistantName)}
            >
              <TierDot color={meta.dotColor} />
              <Typography as="span" variant="body-small-emphasised">
                {meta.label}
              </Typography>
              <Typography
                as="span"
                variant="body-small-default"
                className="text-[color:var(--content-tertiary)]"
              >
                {meta.sublabel}
                {tier === defaultTier ? " · default" : ""}
              </Typography>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
