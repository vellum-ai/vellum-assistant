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
  "When the user asks for help with marketing — or anything under positioning, demand gen, launches, content, GEO, competitive analysis, campaigns, or funnel analytics (including for a startup or small business) — load the `marketing-expert` skill first (it carries the operating principles and routes to the right playbook), then act as their marketing expert and reach for the plugin's tools like `funnel_math`.";
