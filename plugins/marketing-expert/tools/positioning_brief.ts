/**
 * `positioning_brief` tool — builds an April Dunford positioning canvas from the
 * facts provided and returns a gap checklist of what's missing or weak.
 *
 * Deterministic structure + validation; the model fills the prose. This enforces
 * the discipline of positioning (start from competitive alternatives, not from a
 * tagline) rather than generating numbers.
 */

import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@vellumai/plugin-api";
import { RiskLevel } from "@vellumai/plugin-api";

interface PositioningInput {
  product?: string;
  competitive_alternatives?: string[];
  unique_attributes?: string[];
  value_themes?: string[];
  target_segment?: string;
  market_category?: string;
  proof_points?: string[];
}

const list = (v?: string[]): string[] => (Array.isArray(v) ? v.filter(Boolean) : []);

const tool: ToolDefinition = {
  description:
    "Builds an April Dunford positioning canvas (competitive alternatives → unique attributes → value → who cares → market category) from the facts you provide and returns a gap checklist of what's missing or weak. Use when shaping or pressure-testing positioning.",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      product: { type: "string", description: "The product/company being positioned." },
      competitive_alternatives: { type: "array", items: { type: "string" }, description: "What customers would use if you didn't exist (incl. status quo / 'do nothing')." },
      unique_attributes: { type: "array", items: { type: "string" }, description: "Capabilities/features you have that the alternatives lack." },
      value_themes: { type: "array", items: { type: "string" }, description: "The value those attributes enable for the customer." },
      target_segment: { type: "string", description: "The segment that cares most about that value (best-fit ICP)." },
      market_category: { type: "string", description: "The market frame of reference you want buyers to slot you into." },
      proof_points: { type: "array", items: { type: "string" }, description: "Evidence: metrics, customers, benchmarks." },
    },
  },

  async execute(input: PositioningInput, _ctx: ToolContext): Promise<ToolExecutionResult> {
    const i = input ?? {};
    const alts = list(i.competitive_alternatives);
    const attrs = list(i.unique_attributes);
    const values = list(i.value_themes);
    const proof = list(i.proof_points);

    const gaps: string[] = [];
    if (!i.product) gaps.push("product is not named.");
    if (alts.length === 0) gaps.push("competitive_alternatives missing — positioning MUST start here (include the status quo / 'do nothing').");
    if (attrs.length === 0) gaps.push("unique_attributes missing — what do you have that the alternatives don't?");
    if (values.length === 0) gaps.push("value_themes missing — translate attributes into customer value (so-what).");
    else if (attrs.length > 0 && values.length < attrs.length) gaps.push("not every unique attribute is mapped to a value theme — close the attribute→value links.");
    if (!i.target_segment) gaps.push("target_segment missing — name the customers who care MOST about this value.");
    if (!i.market_category) gaps.push("market_category missing — what frame of reference should buyers use to understand you?");
    if (proof.length === 0) gaps.push("proof_points missing — claims without evidence won't land with a skeptical buyer.");

    const canvas = {
      product: i.product ?? null,
      "1_competitive_alternatives": alts.length ? alts : null,
      "2_unique_attributes": attrs.length ? attrs : null,
      "3_value_(so_what)": values.length ? values : null,
      "4_who_cares_most_(target_segment)": i.target_segment ?? null,
      "5_market_category_(frame_of_reference)": i.market_category ?? null,
      proof_points: proof.length ? proof : null,
    };

    const guidance = [
      "Fill top-to-bottom: alternatives anchor everything. If alternatives are wrong, the rest is wrong.",
      "Each unique attribute should map to a value theme; each value theme should map to the segment that cares.",
      "The market category sets buyer expectations — pick the frame that makes your strengths obvious and your gaps irrelevant.",
      "After filling gaps, draft a one-sentence positioning statement and a 3-tier messaging hierarchy (umbrella → pillars → proof).",
    ];

    return {
      content: JSON.stringify({ dunford_positioning_canvas: canvas, gaps_to_close: gaps, next_steps: guidance }, null, 2),
      isError: false,
    };
  },
};

export default tool;
