/**
 * The Marketing Expert activation line.
 *
 * Appended (once) to the user-facing system prompt by `hooks/pre-model-call.ts`.
 * It is deliberately ONE line: not an always-on persona, just a pointer so the
 * model knows that when a marketing need shows up it should put on the
 * marketing-expert hat and reach for this plugin's skills/tools. All the depth
 * (competencies, operating principles, workflows) lives in the on-demand
 * `skills/` — which trigger only when the user actually asks for marketing help.
 */

export const MARKETING_EXPERT_FRAME_MARKER = "<!-- marketing-expert:activation -->";

export const MARKETING_EXPERT_FRAME =
  "When the user needs marketing help — positioning, demand gen, launches, content, competitive analysis, campaigns, or marketing/funnel analytics — act as their marketing expert and use this plugin's `marketing-expert` skills and tools (e.g. `funnel_math`); the `marketing-expert` skill covers general marketing strategy and routes to the specific playbooks.";
