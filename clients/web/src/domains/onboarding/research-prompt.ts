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

/**
 * A specialized capability (marketplace plugin) the assistant can offer to
 * invoke on the user's behalf. `name` is the install name (e.g.
 * "marketing-expert"); `description` is a one-line summary. The runner compacts
 * the live catalog into these before injecting them so the prompt never bloats.
 */
export interface AvailableCapability {
  name: string;
  description: string;
}

/** Cap on injected capabilities so a growing marketplace can't bloat the turn. */
const MAX_INJECTED_CAPABILITIES = 12;

/**
 * Render the "capabilities you can offer" block. Compact by construction: one
 * short line per capability (`- name — description`), capped. Returns "" when
 * nothing was passed so the prompt is byte-for-byte unchanged for callers that
 * don't inject a catalog (e.g. the route's fallback kickoff message).
 */
function renderCapabilitiesBlock(capabilities: AvailableCapability[]): string {
  const lines = capabilities
    .slice(0, MAX_INJECTED_CAPABILITIES)
    .map((c) => `- ${c.name} — ${c.description}`)
    .join("\n");
  if (!lines) return "";
  return `
Capabilities you can offer me — specialized skillsets you can invoke on my behalf, not generic chat:
${lines}

Add ONE more top-level key alongside "claims" and "suggestions": a "plugins" array naming the 1-2 capabilities from the list above (exact names) that best fit who I am — judged by what you researched about my real role, stack, and day-to-day work. These get set up for me automatically as part of getting started, so pick by overall fit to ME, not to any single suggestion. Prefer fewer over forcing a match; use [] if nothing clearly fits. Example: "plugins": ["<exact name from the list above>"]. Don't reference the setup in the claims or suggestions text.
`;
}

export function buildResearchPrompt(
  { firstName, lastName, occupation, hobby }: ResearchSubject,
  availableCapabilities: AvailableCapability[] = [],
): string {
  const fullName = [firstName.trim(), lastName.trim()]
    .filter(Boolean)
    .join(" ");
  const role = occupation.trim();
  const hobbyText = hobby?.trim() ?? "";
  const capabilitiesBlock = renderCapabilitiesBlock(availableCapabilities);

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

{ "claims": [ { "claim": "Senior engineer at an AI infra startup", "confidence": "confident", "sources": ["https://linkedin.com/in/example-user"] }, { "claim": "Based in Boulder, CO", "confidence": "confident", "sources": ["https://linkedin.com/in/example-user"] }, { "claim": "Active climber on Mountain Project", "confidence": "maybe", "sources": [] }, { "claim": "Focused on evals or model serving infrastructure", "confidence": "guessing", "sources": ["https://github.com/example-user"] } ], "suggestions": [ { "suggestion": "I'll build you a dashboard for your eval runs", "prompt": "Build me a dashboard to track my eval runs." }, { "suggestion": "I'll watch arXiv for new eval papers and brief you weekly", "prompt": "Send me a weekly brief on new eval papers from arXiv." }, { "suggestion": "Connect GitHub and I'll triage your stalest issues", "prompt": "Connect to GitHub and triage my oldest open issues." }, { "suggestion": "I'll plan a weekend climbing trip near Boulder", "prompt": "Plan me a weekend climbing trip near Boulder." } ] }

Rules for "claims":

AT MOST 5 claims, typically 3 to 4. Aim for at least one "confident" and at least one "guessing"; the rest "maybe".
Phrase each claim in third person as a short headline ("Senior engineer at an AI infra startup", "Based in Boulder, CO", "Active climber on Mountain Project"). No multi-clause sentences, no em-dash asides, no explanations. Good: "Contributed to Chirps (vector-DB security)". Bad: "You've done real work in vector database security. You contributed to Chirps, a tool for scanning vector DBs for sensitive data".
Each claim must be independently true-or-false so I can remove the ones that are wrong.
"confidence" is one of: "confident" (well supported by what you found), "maybe" (plausible but unverified), "guessing" (a hunch from limited signal).
"sources": 0 to 3 URLs you actually used as evidence for that specific claim. Use [] for pure inferences.
Rules for "suggestions":

Each suggestion is an object with two fields:
"suggestion": the offer spoken in YOUR voice (the assistant), exactly as it appears on the clickable card. First-person "I" here refers to you. This is what the user reads.
"prompt": the message that is sent on the user's behalf when they click that card, written from the USER's perspective in their first person — what they'd say to take you up on the offer. First-person "I"/"my" here refers to the user. Same intent as the suggestion, re-voiced as a request TO you (e.g. suggestion "I'll build you a training plan" → prompt "Build me a training plan for my next climbing trip"). Never echo the assistant-voiced wording in the prompt. Don't ask the user a question back in the prompt — it's their opening message, so state the request. Keep it natural and concise.

Generate EXACTLY 4 suggestions, each teaching me something you can do — aim to make me think "wait, you can do that?" Cover four DIFFERENT capabilities; don't repeat the same kind of task. Draw on your range: build a small app or dashboard, set up a recurring brief or monitor, draft a doc in a live editor, connect an integration (GitHub, Gmail, Calendar, Slack, Linear) and take a first action, or lean on a hobby/personal hook if research surfaced one. Pick whatever genuinely fits — don't force a fixed set of themes.
Ground every suggestion in what you actually learned about me during research — my real role, stack, industry, and (if given) hobby. Specific to me, not generic LLM-assistant stuff. Avoid "summarize" or "draft a post" as standalone suggestions; favor the surprising, specific capabilities (apps, monitors, doc editor, integrations).
Keep each suggestion SHORT and skimmable: aim for under 10 words, ONE clause, ONE artifact. No lists of three ("X, Y, and Z"), no intake question stacked in front of the offer. The reader scans four cards in a couple of seconds — a long line loses them.
Favor easy, fast-to-first-output tasks over big builds, so my first reply lands quickly. Prefer "I'll set up a morning brief for today's sales calls" over "I'll build a CRM to manage your deals"; prefer one weekly digest, a short plan, or a single connected action over a multi-part system. The ambitious build can come later in the conversation, not on the first card.
Each suggestion should be spoken in your voice, offering a service. First-person "I" in the suggestion refers to you, regardless of your name. Core sentence pattern: "I'll [verb] [specific artifact]" or "Connect me to [integration] and I'll [verb] [artifact]." Lead with the offer itself — no intake question in front of it; you gather the details in the follow-up conversation after the click. Suggestions render as clickable; clicking indicates the user wants to proceed. Refinement happens in follow-up conversation, not through the click itself.
${capabilitiesBlock}
Don't include anything sensitive or private. If you found very little, lean on "guessing" claims and broadly useful suggestions for my role.
Keep every string value simple so the JSON always parses: one line, no line breaks inside a value, and NO double-quote characters inside a value — use single quotes (or none) for emphasis, quoted names, or tool names. Output ONLY the JSON object. No code fence, no extra text.`;
}
