/**
 * `gtm_launch_plan` tool — turns launch facts into a tiered launch/campaign brief:
 * a launch tier, a channel matrix, a phased timeline checklist, owners, a budget
 * split, and funnel-tied success metrics.
 *
 * Deterministic scaffold: the tier and recommended channel emphasis are derived
 * from the inputs; the model fills the specifics.
 */

import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@vellumai/plugin-api";
import { RiskLevel } from "@vellumai/plugin-api";

interface LaunchInput {
  what_is_launching?: string;
  impact?: "tier1" | "tier2" | "tier3";
  audience?: string;
  primary_goal?: "awareness" | "pipeline" | "adoption" | "expansion";
  launch_date?: string;
  budget?: number;
  motion?: "plg" | "sales_led" | "hybrid";
}

const CHANNEL_EMPHASIS: Record<string, string[]> = {
  awareness: ["PR / launch story", "founder & exec social", "thought-leadership content", "community", "paid social (reach)"],
  pipeline: ["targeted email & nurture", "paid search/social (intent)", "ABM to named accounts", "webinar / demo", "sales enablement kit"],
  adoption: ["in-product announcement", "docs & tutorials / how-to", "lifecycle email", "changelog / blog", "user community"],
  expansion: ["customer email & CSM enablement", "upsell in-product", "case studies", "customer webinar", "account-based plays"],
};

const TIER_PHASES = (tier: string): Record<string, string[]> => {
  const base = {
    pre_launch: ["Lock positioning & messaging (use positioning_brief)", "Finalize asset list & owners", "Brief sales/CS", "Stage assets & schedule"],
    launch_day: ["Publish hero asset", "Coordinated social + email", "Notify customers", "Enable sales talking points"],
    post_launch: ["Amplify & repurpose", "Measure vs. success metrics", "Run a retro", "Fold learnings into next launch"],
  };
  if (tier === "tier1") {
    base.pre_launch.unshift("Exec/analyst/press pre-briefs under embargo");
    base.launch_day.push("Live event / launch webinar");
  }
  return base;
};

const tool: ToolDefinition = {
  description:
    "Produces a tiered GTM launch/campaign brief: launch tier, channel matrix, phased timeline checklist, owners, budget split, and funnel-tied success metrics. Use for product launches and campaigns.",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      what_is_launching: { type: "string", description: "Product, feature, or campaign being launched." },
      impact: { type: "string", enum: ["tier1", "tier2", "tier3"], description: "Strategic impact. tier1 = company-defining, tier2 = notable, tier3 = incremental." },
      audience: { type: "string", description: "Primary target audience / ICP." },
      primary_goal: { type: "string", enum: ["awareness", "pipeline", "adoption", "expansion"], description: "The single primary objective." },
      launch_date: { type: "string", description: "Target launch date." },
      budget: { type: "number", description: "Total budget available for the launch." },
      motion: { type: "string", enum: ["plg", "sales_led", "hybrid"], description: "GTM motion. Defaults to hybrid." },
    },
  },

  async execute(input: LaunchInput, _ctx: ToolContext): Promise<ToolExecutionResult> {
    const i = input ?? {};
    const tier = i.impact ?? "tier2";
    const goal = i.primary_goal ?? "pipeline";
    const motion = i.motion ?? "hybrid";

    const channels = CHANNEL_EMPHASIS[goal] ?? CHANNEL_EMPHASIS.pipeline;
    if (motion === "plg" && !channels.includes("in-product announcement")) channels.push("in-product announcement");
    if (motion === "sales_led" && !channels.includes("ABM to named accounts")) channels.push("ABM to named accounts");

    const successMetrics: Record<string, string> = {
      awareness: "Reach/impressions, branded search lift, share of voice, net-new traffic.",
      pipeline: "MQLs, SQLs, sourced pipeline ($), and opportunities — value with funnel_math.",
      adoption: "Activation rate, feature usage, time-to-value, week-1 retention.",
      expansion: "Expansion pipeline, seats/usage growth, NRR contribution.",
    };

    let budgetSplit: Record<string, string> | string = "Provide budget to get a recommended split.";
    if (typeof i.budget === "number") {
      const b = i.budget;
      const split =
        goal === "awareness"
          ? { content_and_creative: 0.35, paid_amplification: 0.4, pr_and_events: 0.2, tooling: 0.05 }
          : goal === "pipeline"
            ? { paid_intent: 0.45, content_and_nurture: 0.25, events_webinars: 0.2, tooling: 0.1 }
            : { content_and_enablement: 0.5, lifecycle_tooling: 0.3, paid: 0.1, contingency: 0.1 };
      budgetSplit = Object.fromEntries(
        Object.entries(split).map(([k, pct]) => [k, `$${Math.round(b * pct).toLocaleString()} (${Math.round(pct * 100)}%)`]),
      );
    }

    const gaps: string[] = [];
    if (!i.what_is_launching) gaps.push("what_is_launching not specified.");
    if (!i.audience) gaps.push("audience/ICP not specified.");
    if (!i.launch_date) gaps.push("launch_date not set — work the timeline backward from it.");
    if (i.impact === undefined) gaps.push("impact tier assumed tier2 — confirm strategic weight.");

    const brief = {
      launching: i.what_is_launching ?? null,
      tier,
      primary_goal: goal,
      motion,
      audience: i.audience ?? null,
      launch_date: i.launch_date ?? null,
      recommended_channels: channels,
      timeline_checklist: TIER_PHASES(tier),
      owners_to_assign: ["DRI (launch lead)", "Product marketing", "Content", "Demand gen / growth", "Sales/CS enablement", "Design"],
      budget_split: budgetSplit,
      success_metrics: successMetrics[goal],
      gaps_to_close: gaps,
    };

    return { content: JSON.stringify(brief, null, 2), isError: false };
  },
};

export default tool;
