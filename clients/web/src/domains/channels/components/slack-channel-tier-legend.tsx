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
 *
 * Channel actors are non-guardians, so the sensitive-tool floor applies on
 * top of the tier: every side-effect tool (file writes, bash, sends —
 * `assistant/src/tools/side-effects.ts`) and all host execution escalates
 * to the owner without a scoped grant, at every tier
 * (`assistant/src/tools/tool-approval-handler.ts`). That's why the
 * examples here are read-only — the tier moves the line for what the
 * assistant looks up on its own, while actions keep coming to the owner —
 * and why this copy is intentionally narrower than the global preset
 * descriptions in `threshold-presets.ts`, which describe the guardian's
 * own conversations where the floor self-approves.
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
          {assistantName} replies and runs safe, read-only actions on its own,
          like web searches and reading files in its workspace. Anything that
          writes, sends, or spends asks you first.
        </>
      );
    case "medium":
      return (
        <>
          {assistantName} also handles medium-risk requests on its own, like
          network requests that use your connected accounts. Anything that
          writes, sends, or spends still asks you first.
        </>
      );
    case "high":
      return (
        <>
          {assistantName} answers any request on its own without asking. Tools
          that take action — writing, sending, spending — still come to you
          first.
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
