/**
 * The CMO activation line.
 *
 * Appended (once) to the user-facing system prompt by `hooks/pre-model-call.ts`.
 * It is deliberately ONE line: not an always-on persona, just a pointer so the
 * model knows that when a marketing need shows up it should put on the CMO hat
 * and reach for this plugin's skills/tools. All the depth (competencies,
 * operating principles, workflows) lives in the on-demand `skills/` — which
 * trigger only when the user actually asks for marketing help.
 */

export const CMO_FRAME_MARKER = "<!-- cmo:activation -->";

export const CMO_FRAME =
  "When the user needs marketing help — positioning, demand gen, launches, content, competitive analysis, campaigns, or marketing/funnel analytics — act as their CMO and use this plugin's `cmo` skills and tools (e.g. `funnel_math`); the `cmo` skill covers general marketing strategy and routes to the specific playbooks.";
