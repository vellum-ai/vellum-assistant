import {
  FIRST_RUN_SCOPE_DATA_KEY,
  FIRST_RUN_SCOPE_OPTION_IDS,
  type FirstRunScope,
} from "./first-run-scope";

/** Renders one choice option's wire fields (id + data payload) for the prompt. */
function optionWire(scope: FirstRunScope): string {
  return `id \`${FIRST_RUN_SCOPE_OPTION_IDS[scope]}\`, \`data: {"${FIRST_RUN_SCOPE_DATA_KEY}": "${scope}"}\``;
}

/**
 * Hidden kickoff sent on the user's behalf when they hit "Let's chat" at the
 * end of the research-onboarding flow. It drives the assistant's first
 * reply but renders no user bubble, so the chat opens with the assistant
 * proactively greeting the user in the persona they just configured.
 *
 * The greeting turn is told not to read any files, so its only sources of
 * identity are the system prompt and this message. The chosen assistant name
 * rides the message itself as a backstop: if the personality rewrite timed
 * out or IDENTITY.md's name is still a placeholder when the turn's system
 * prompt is built, the model would otherwise invent a name for its very first
 * words to the user.
 *
 * The greeting ends with a scope question backed by a single `ui_show` choice
 * surface offering three clickable options (work / personal / both). The
 * option ids and `data` payloads come from `first-run-scope.ts` — they're the
 * wire contract a click-telemetry consumer matches on.
 */
export function buildLetsChatKickoffMessage(assistantName?: string): string {
  const name = assistantName?.trim();
  const nameLine = name
    ? `\nYour name is ${name} — introduce yourself as ${name}.`
    : "";
  return `You're about to begin your first conversation.${nameLine}
Respond with a warm and engaging greeting. Be interesting, be real. This is your chance to get to know and impress the user.
End the greeting text with one short question asking where they'd like to start, phrased so nothing feels off the table (e.g. "…or is there anything else on your mind entirely?").
Then call the \`ui_show\` tool exactly once: \`surface_type: "choice"\`, \`data.selectionMode: "single"\`, no \`title\` (or a very short one), and exactly three options in this order:
1. ${optionWire("work")} — a concrete offer grounded in their work or role from your Onboarding Context (occupation, daily tools, work-related research findings).
2. ${optionWire("personal")} — a concrete offer grounded in their hobbies, interests, or personal research findings.
3. ${optionWire("both")} — an "all of the above" invitation.
An option's title becomes the user's visible reply bubble when they tap it, so every title must read naturally in the user's voice — imperative or neutral, ten words or fewer (e.g. "Help me plan my next ride", never "I can plan your next ride"). Put richer color in your own voice in each option's one-sentence \`description\` instead.
These options are conversation starters, not a menu: never imply the user is limited to them, and your closing question itself must invite free-form answers.
After the \`ui_show\` result comes back, stop — output no further text. If \`ui_show\` errors or is unavailable, just end with the text question alone; the user will type. Do not set \`await_action\` or \`persistent\`.
Keep it short! For this opening greeting only, don't use \`recall\`, don't read any files, and make no tool calls other than that single \`ui_show\`. (This applies to the greeting alone; use your tools normally for everything the user asks afterward.)`;
}
