import type { ReactNode } from "react";
import { Link } from "react-router";

import { Card } from "@vellumai/design-library/components/card";
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
 * Per-tier help copy, framed around behavior toward the people in the
 * channel: what the assistant does on its own when responding, and what
 * waits for the owner. Lives here rather than in `CAPABILITY_TIER_META`
 * because it interpolates the assistant's name; the Trust Rules footnote
 * below the grid links out to the Privacy settings page.
 *
 * Grounded in the live approval pipeline
 * (`assistant/src/permissions/checker.ts` → `approval-policy.ts`): each
 * call's risk is classified first — with the user's Trust Rules applied as
 * per-action risk re-classifications (low/medium/high) — and then compared
 * against this channel's tier. At `none` nothing is within threshold, so
 * every action prompts; Trust Rules move an action between levels (changing
 * when it asks) but cannot bypass Strict or hard-block at Full access,
 * which is why the footnote describes them as tuning, not overriding.
 * Workspace file writes classify low, so they auto-run from Conservative
 * up (`gateway/src/risk/file-risk-classifier.ts`); host-side file changes
 * are medium. Sensitive tools sit above the threshold entirely — for
 * non-guardian actors they always escalate to the owner without a scoped
 * grant (`assistant/src/tools/tool-approval-handler.ts`), so the
 * full-access copy keeps that caveat.
 */
function tierDescription(
  tier: RiskThreshold,
  assistantName: string,
): ReactNode {
  switch (tier) {
    case "none":
      return (
        <>
          {assistantName} replies in this channel, but asks you before taking
          any action.
        </>
      );
    case "low":
      return (
        <>
          {assistantName} replies and runs low-risk actions on its own, like web
          searches and reading and writing files in its own workspace. Riskier
          actions ask first.
        </>
      );
    case "medium":
      return (
        <>
          {assistantName} also runs medium-risk actions, like changing files
          outside its own workspace. High-risk actions still ask first.
        </>
      );
    case "high":
      return (
        <>
          {assistantName} runs any tool it has access to without asking.
          Sensitive tools still come to you first.
        </>
      );
  }
}

export interface SlackChannelTierLegendProps {
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantName: string;
}

/**
 * One-time Assistant Access legend card beside the channel list: every tier
 * with its behavior description, so the expanded rows don't repeat the same
 * paragraph per channel.
 */
export function SlackChannelTierLegend({
  assistantName,
}: SlackChannelTierLegendProps) {
  return (
    <Card.Root>
      <Card.Header>Assistant Access levels</Card.Header>
      <Card.Body className="grid gap-4 sm:grid-cols-2">
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
      </Card.Body>
      <Card.Footer>
        <Typography
          as="p"
          variant="body-small-default"
          className="text-[color:var(--content-tertiary)]"
        >
          Your{" "}
          <Link
            to={routes.settings.privacy}
            className="text-[var(--content-link)] underline hover:text-[var(--content-link-hover)]"
          >
            Trust Rules
          </Link>{" "}
          fine-tune these levels: a rule raises or lowers how risky a specific
          action is treated, which changes when it asks first.
        </Typography>
      </Card.Footer>
    </Card.Root>
  );
}
