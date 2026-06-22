/**
 * Builds the "research me" message auto-sent to the assistant at the end of
 * the research-onboarding flow.
 *
 * SPIKE — research-onboarding flow.
 *
 * This message becomes `PreChatOnboardingContext.initialMessage`, which the
 * existing onboarding auto-send pipeline fires as the user's first message
 * once the assistant is reachable. The assistant does a web-research pass on
 * the person described by the collected fields and returns a structured list
 * of inferred facts (each with a confidence tier) as a fenced JSON block. The
 * focused-onboarding overlay parses that block and renders the editable
 * "Here's what I know about you" card.
 *
 * The output contract here MUST stay in sync with the parser in
 * `@/domains/chat/onboarding-research/research-facts.ts`.
 *
 * NOTE(alex): the wording / claim count / confidence rubric / suggestion
 * guidance are all tunable — only the trailing JSON contract (`claims` +
 * `suggestions` shape) is load-bearing for the UI.
 */

export interface ResearchSubject {
  firstName: string;
  lastName: string;
  occupation: string;
  hobby?: string;
}

export function buildResearchPrompt({
  firstName,
  lastName,
  occupation,
  hobby,
}: ResearchSubject): string {
  const fullName = [firstName.trim(), lastName.trim()]
    .filter(Boolean)
    .join(" ");
  const role = occupation.trim();
  const hobbyText = hobby?.trim() ?? "";

  const identity =
    [
      fullName ? `My name is ${fullName}.` : "",
      role ? `I work as ${role}.` : "",
      hobbyText ? `My hobby is ${hobbyText}.` : "",
    ]
      .filter(Boolean)
      .join(" ") ||
    "I'd like you to get to know me before we start working together.";

  return `${identity}

Get to know me. Search the web for what's publicly known about the person matching my name and role, and infer a handful of things about who I am: what I do, my role, where I'm based, what I'm into, anything that would help you assist me better. Lean on public sources (LinkedIn, company pages, social profiles, articles, personal sites, GitHub). It's fine to make reasonable inferences and label them honestly.

CRITICAL: your final reply must be ONLY a JSON object. No preamble, no explanation, no prose, nothing before or after it. Do your thinking and searching, then respond with exactly this shape and nothing else:

{ "claims": [ { "claim": "Senior engineer at an AI infra startup", "confidence": "confident", "sources": ["https://linkedin.com/in/example-user"] }, { "claim": "Based in Boulder, CO", "confidence": "confident", "sources": ["https://linkedin.com/in/example-user"] }, { "claim": "Active climber on Mountain Project", "confidence": "maybe", "sources": [] }, { "claim": "Focused on evals or model serving infrastructure", "confidence": "guessing", "sources": ["https://github.com/example-user"] } ], "suggestions": [ "Got any climbing trips coming up? I'll build a training plan, scout crags, and track your sends", "I'll send a weekly briefing on what's happening in your industry, only the parts worth your time.", "Connect me to GitHub and I'll handle projects from brief to merged PR", "I'll handle your weekly grocery list, travel packing, and family schedule" ] }

Rules for "claims":

AT MOST 5 claims, typically 3 to 4. Aim for at least one "confident" and at least one "guessing"; the rest "maybe".
Phrase each claim in third person as a short headline ("Senior engineer at an AI infra startup", "Based in Boulder, CO", "Active climber on Mountain Project"). No multi-clause sentences, no em-dash asides, no explanations. Good: "Contributed to Chirps (vector-DB security)". Bad: "You've done real work in vector database security. You contributed to Chirps, a tool for scanning vector DBs for sensitive data".
Each claim must be independently true-or-false so I can remove the ones that are wrong.
"confidence" is one of: "confident" (well supported by what you found), "maybe" (plausible but unverified), "guessing" (a hunch from limited signal).
"sources": 0 to 3 URLs you actually used as evidence for that specific claim. Use [] for pure inferences.
Rules for "suggestions":

Generate EXACTLY 4 suggestions. One per slot, in this order:
Lifestyle (hobby-driven). Use the hobby if one was given, otherwise fall back to broad lifestyle hooks (fitness, learning, travel, projects). Anchor on the app builder or dashboard capability. End with a specific artifact ("training plan", "scout crags", "sent tracker", "practice schedule"). Open with an intake question that gathers the info needed to scope the offer. Timing-driven for hobbies with dates ("Got any...coming up? I'll build a training plan"), goals for skills ("What are you working on? I'll set up a practice schedule"), recurring for habits ("Want a weekly...? I'll keep it going"). The offer still has to follow.
Industry (vertical-driven). Anchor on what they build or sell, not their day-to-day function (LLM infra, fintech, healthcare, GTM, devtools). Anchor on the heartbeat or scheduled monitor capability. Specific artifact ("weekly briefing on what's happening in your industry", "week's news roundup"). Open as a declarative offer ("I'll send a weekly briefing on what's happening in your industry, only the parts worth your time").
Role (occupation-driven). Anchor on their day-to-day function (SWE, PM, designer, founder, marketer). Pick the integration OR live document editor capability, whichever fits the function best. Integrations for builders and analysts (SWE: GitHub; designer: Figma; analyst: data source). Doc editor for strategists and writers (PMM: launch brief; founder: positioning doc). Specific artifact ("merged PR", "Figma sitting-in", "positioning doc", "spaced-repetition tracker").
Life admin (always present). Target the home and personal side. Anchor on the app builder or scheduled monitor capability. The opening should be a flexible conversation opener ("Tell me what admin eats your week" / "Tell me how your household runs and..."). The menu of items should be tuned to occupation when relevant (medical: rotations / CME / expense; founder: tax deadlines / subscriptions / finances; family-heavy: groceries / school pickup / meal planning; default: meal planning / errands / recurring bills). Specific artifact per item ("weekly grocery list", "live view of subscriptions").
Each suggestion should be spoken in your voice, offering a service. First-person "I" in the suggestion refers to you, regardless of your name. Core sentence pattern: "I'll [verb] [specific artifact]" or "Connect me to [integration] and I'll [verb] [artifact]." An intake question can lead ("Tell me about your next trip. I'll build a training plan") as long as the offer is preserved. Suggestions render as clickable; clicking indicates the user wants to proceed. Refinement happens in follow-up conversation, not through the click itself.
Use what you learned about me during research to make each suggestion feel specific to my stack, role, and industry, not generic LLM-assistant stuff. Avoid "summarize" or "draft a post" as standalone suggestions. Favor the surprising, specific capabilities (apps, monitors, doc editor, integrations).
Don't include anything sensitive or private. If you found very little, lean on "guessing" claims and broadly useful suggestions for my role. Output ONLY the JSON object. No code fence, no extra text.`;
}
