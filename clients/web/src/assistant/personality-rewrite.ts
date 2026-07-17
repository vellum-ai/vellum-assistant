/**
 * Shared pieces of the personality-rewrite flow — used by research
 * onboarding's "Create my personality" step and the About Assistant
 * personality page.
 *
 * Both surfaces collect five 0–100 trait sliders and hand them to the
 * assistant as a system-message asking it to rewrite its own identity
 * files (IDENTITY.md / SOUL.md) in a voice matching the new personality —
 * the durable way to reshape its persona, since those files feed every
 * future conversation's system prompt. `buildPersonalityMessage` renders
 * that message; `shouldSettlePersonalityPoll` decides when the rewrite
 * turn has finished.
 */

/**
 * Axis ids the personality sliders key their values by. Each is 0–100 with
 * 0 = the left label and 100 = the right label.
 */
export const PERSONALITY_AXIS_IDS = {
  companionCoworker: "companion-coworker",
  genzBoomer: "genz-boomer",
  executeCollaborate: "execute-collaborate",
  playfulSerious: "playful-serious",
  politeUnfiltered: "polite-unfiltered",
} as const;

/**
 * Consecutive identical assistant reads that mark the rewrite turn settled —
 * fallback only, for daemons that predate the `processing` flag.
 */
const STABLE_READS_TO_SETTLE = 2;

/**
 * Decide whether the rewrite turn is finished. The daemon's `processing` flag
 * is authoritative (`true` while the turn is mid-flight), so prefer it: the
 * rewrite typically emits a "rewriting now…" preamble and then spends most of
 * the turn on file_write calls, during which the visible text is stable —
 * text-stability alone settles ~3s into a turn that runs for tens of seconds,
 * releasing the caller before IDENTITY.md is actually written. A turn
 * counts as finished once `processing` is false AND it has produced evidence
 * of running at all — a visible reply, or an earlier read that caught
 * `processing: true` (`sawProcessing`, which covers a turn whose final
 * message is all tool calls with no text). Requiring that evidence keeps a
 * still-queued turn (`processing` not yet flipped on) from reading as already
 * finished. Daemons that omit the flag settle on text-stability instead.
 */
export function shouldSettlePersonalityPoll({
  processing,
  sawProcessing,
  hasReply,
  stableReads,
}: {
  processing: boolean | undefined;
  sawProcessing: boolean;
  hasReply: boolean;
  stableReads: number;
}): boolean {
  if (processing !== undefined) {
    return !processing && (hasReply || sawProcessing);
  }
  return hasReply && stableReads >= STABLE_READS_TO_SETTLE;
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Render the personality system-message from the five slider values. Pure, so
 * it's unit-testable without the daemon. Each slider's two ends become explicit
 * 0–100 scores (a slider at 70 toward "Coworker" → Companion 30 / Coworker 70).
 */
export function buildPersonalityMessage(
  values: Record<string, number>,
  userName?: string,
  assistantName?: string,
): string {
  const v = (id: string): number => clamp(values[id] ?? 50);
  const companionCoworker = v(PERSONALITY_AXIS_IDS.companionCoworker); // 100 = Coworker
  const executeCollaborate = v(PERSONALITY_AXIS_IDS.executeCollaborate); // 100 = Collaborate
  const playfulSerious = v(PERSONALITY_AXIS_IDS.playfulSerious); // 100 = Serious
  const politeUnfiltered = v(PERSONALITY_AXIS_IDS.politeUnfiltered); // 100 = Unfiltered

  const who = userName?.trim() || "The user";
  // The name instruction must be unambiguous: the rewrite conversation's
  // system prompt may have been snapshotted before the chosen name landed in
  // IDENTITY.md, so "keep your existing name" alone would read a placeholder
  // and invite the model to invent one. When the caller knows the name, state
  // it outright; either way, pin the `- **Name:** …` line format so the
  // onboarding name-seeder's regex keeps matching on later rewrites.
  const chosenName = assistantName?.trim();
  const nameInstruction = chosenName
    ? `Your name is ${chosenName}. Write exactly \`- **Name:** ${chosenName}\` in IDENTITY.md — do not rename yourself or invent a different name, even if the file currently shows a placeholder or a different name. This changes your personality, not who you are.`
    : `Keep your existing name exactly as it is — this changes your personality, not who you are. Do not rename yourself, and if your name is already set, carry it through verbatim (don't treat it as a placeholder to fill). Whatever the name ends up being, keep it on IDENTITY.md's \`- **Name:** …\` line.`;
  return `<system-message>
${who} wants to customize your personality.
This is what they want you to be:
Companion (0-100): ${100 - companionCoworker}
Coworker (0-100): ${companionCoworker}
Voice Style (0 = Gen Z, 100 = Boomer): ${v(PERSONALITY_AXIS_IDS.genzBoomer)}
Execute Independently (0 - 100): ${100 - executeCollaborate}
Collaborative (0 - 100): ${executeCollaborate}
Playfulness (0 - 100): ${100 - playfulSerious}
Seriousness (0 - 100): ${playfulSerious}
Politeness (0 - 100): ${100 - politeUnfiltered}
Unfiltered Rawness/Crassness (0 - 100): ${politeUnfiltered}

Rewrite your own identity files (IDENTITY.md and SOUL.md) to reflect your new personality — first person, in a voice and style that matches it. Do not touch users/guardian.md or anything else under users/: that is your user's profile (their name, work, preferences), not your identity.

Overwrite each file completely with file_write: write the whole file fresh in one pass. This is a from-scratch rewrite, not an edit — do not append to what's already there, do not patch individual lines, and leave none of the current default wording behind. Fill in every IDENTITY.md placeholder (the _(not yet chosen)_ / _(not yet established)_ fields).

IDENTITY.md must keep a line reading exactly \`- **Personality:** <one short sentence>\` — a single sentence summarizing this new personality in your own voice. UI surfaces parse that exact line format to display your personality, so do not omit or reformat it.

${nameInstruction}

Each rewritten file must still be complete: SOUL.md keeps everything you operate by — how you use memory, your boundaries, your compliance stance — re-expressed in your new voice rather than dropped. When you finish, both files should read top-to-bottom as this new personality, with nothing left in the generic default voice.
</system-message>`;
}
