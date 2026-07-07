/**
 * Hidden kickoff sent on the user's behalf when they hit "Let's chat" at the
 * end of the personality-onboarding flow. It drives the assistant's first
 * reply but renders no user bubble, so the chat opens with the assistant
 * proactively greeting the user in the persona they just configured.
 *
 * The greeting turn is told not to read any files, so its only sources of
 * identity are the system prompt and this message. The chosen assistant name
 * rides the message itself as a backstop: if the personality rewrite timed
 * out or IDENTITY.md's name is still a placeholder when the turn's system
 * prompt is built, the model would otherwise invent a name for its very first
 * words to the user.
 */
export function buildLetsChatKickoffMessage(assistantName?: string): string {
  const name = assistantName?.trim();
  const nameLine = name
    ? `\nYour name is ${name} — introduce yourself as ${name}.`
    : "";
  return `You're about to begin your first conversation.${nameLine}
Respond with a warm and engaging greeting. Be interesting, be real. This is your chance to get to know and impress the user.
Keep it short! For this opening greeting only, don't use \`recall\` or read any files — just say hello. (This applies to the greeting alone; use your tools normally for everything the user asks afterward.)`;
}
