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
 * for the owner. Rendered inline under each tier name in the key, so the
 * meaning is on screen without hovering — plain text (not JSX) because it
 * interpolates the assistant name. The terse `CAPABILITY_TIER_META.sublabel`
 * is the picker's short form ({@link TierPicker}), not used here.
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
      return `${assistantName} replies, but asks you before looking anything up — even a web search.`;
    case "low":
      return `Low-risk lookups run on their own: web searches, reading files in ${assistantName}'s own workspace.`;
    case "medium":
      return `Also allows medium-risk lookups to run on their own.`;
    case "high":
      return `Any lookup runs on its own, including reads of sensitive local files.`;
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
 * escalates), then every tier in a two-column grid as its name over the full
 * {@link tierDescription} sentence. Everything renders on screen — no hover
 * tooltip — so the meaning is reachable on touch. The tier the global default
 * resolves to is marked "· default", matching the per-row picker so the two
 * read together.
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
        Applies to other people in the channel — your own requests use your
        global Assistant Access. The levels only cover how much {assistantName}{" "}
        looks up on its own before answering; writing, sending, and spending
        always come to you first, at every level. Your{" "}
        <Link
          to={routes.settings.privacy}
          className="text-[var(--content-link)] underline hover:text-[var(--content-link-hover)]"
        >
          Trust Rules
        </Link>{" "}
        fine-tune when it asks.
      </Typography>
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {CAPABILITY_TIER_VALUES.map((tier) => {
          const meta = CAPABILITY_TIER_META[tier];
          return (
            <li key={tier} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <TierDot color={meta.dotColor} />
                <Typography as="span" variant="body-small-emphasised">
                  {meta.label}
                </Typography>
                {tier === defaultTier ? (
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
    </div>
  );
}
