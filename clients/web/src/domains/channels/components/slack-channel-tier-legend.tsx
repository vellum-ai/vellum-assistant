import { Link } from "react-router";

import type { TagTone } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  CAPABILITY_TIER_META,
  CAPABILITY_TIER_VALUES,
} from "@/domains/channels/slack-channel-overrides";
import type { RiskThreshold } from "@/utils/threshold-presets";
import { routes } from "@/utils/routes";

/** Dot accent per tier tone — mirrors the Tag component's icon accents. */
const TONE_DOT_COLOR: Record<TagTone, string> = {
  positive: "var(--system-positive-strong)",
  negative: "var(--system-negative-strong)",
  warning: "var(--system-mid-strong)",
  info: "var(--system-info-strong)",
  neutral: "var(--content-secondary)",
};

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
 * footnote describes them as tuning, not overriding.
 *
 * Channel actors are non-guardians, so the sensitive-tool floor applies on top
 * of the tier: every side-effect tool (file writes, bash, sends —
 * `assistant/src/tools/side-effects.ts`) and all host execution escalates to
 * the owner without a scoped grant, at every tier
 * (`assistant/src/tools/tool-approval-handler.ts`). That's why the examples
 * here are read-only — the tier moves the line for what the assistant looks up
 * on its own, while actions keep coming to the owner — and why this copy is
 * intentionally narrower than the global preset descriptions in
 * `threshold-presets.ts`, which describe the guardian's own conversations where
 * the floor self-approves.
 */
function tierDescription(tier: RiskThreshold, assistantName: string): string {
  switch (tier) {
    case "none":
      return `${assistantName} replies in this channel, but asks you before taking any action.`;
    case "low":
      return `${assistantName} replies and runs safe, read-only actions on its own, like web searches and reading files in its workspace. Anything that writes, sends, or spends asks you first.`;
    case "medium":
      return `${assistantName} also handles medium-risk requests on its own, like network requests that use your connected accounts. Anything that writes, sends, or spends still asks you first.`;
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
 * Always-visible Assistant Access key at the foot of the channel list card:
 * every tier as a compact "label + what it does" pair, laid out side by side so
 * the meaning is on screen without opening anything. The full behavior sentence
 * rides each pair's hover tooltip. The tier the global default resolves to is
 * marked "· default", matching the per-row picker so the two read together.
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
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {CAPABILITY_TIER_VALUES.map((tier) => {
          const meta = CAPABILITY_TIER_META[tier];
          return (
            <li
              key={tier}
              className="flex items-center gap-1.5"
              title={tierDescription(tier, assistantName)}
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: TONE_DOT_COLOR[meta.tone] }}
              />
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
      <Typography
        as="p"
        variant="body-small-default"
        className="text-[color:var(--content-tertiary)]"
      >
        Writes, sends, and spends always come to you first — at every level.
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
