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
 * NOTE(alex): first-draft prompt (the original was lost). Tune the wording /
 * claim count / confidence rubric freely — only the trailing JSON contract is
 * load-bearing for the UI.
 */

export interface ResearchSubject {
  firstName: string;
  lastName: string;
  occupation: string;
}

export function buildResearchPrompt({
  firstName,
  lastName,
  occupation,
}: ResearchSubject): string {
  const fullName = [firstName.trim(), lastName.trim()]
    .filter(Boolean)
    .join(" ");
  const role = occupation.trim();

  const identity = [
    fullName ? `My name is ${fullName}.` : "",
    role ? `I work as ${role}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    identity ||
      "I'd like you to get to know me before we start working together.",
    "",
    "Before we dive in, get to know me. Search the web for what's publicly",
    "known about the person matching my name and role, and infer a handful of",
    "things about who I am — what I do, my role, where I'm based, what I'm into,",
    "anything that would help you assist me better. Lean on public sources",
    "(LinkedIn, company pages, social profiles, articles). It's fine to make",
    "reasonable inferences and label them honestly.",
    "",
    "CRITICAL — your final reply must be ONLY a JSON object. No preamble, no",
    "explanation, no prose, nothing before or after it. Do your thinking and",
    "searching, then respond with exactly this shape and nothing else:",
    "",
    "{",
    '  "claims": [',
    '    { "claim": "Software engineer in Columbus, OH", "confidence": "confident", "sources": ["https://github.com/you"] },',
    '    { "claim": "You climb outdoors", "confidence": "maybe", "sources": [] },',
    '    { "claim": "Head of growth at Vellum", "confidence": "guessing", "sources": ["https://example.com/about"] }',
    "  ],",
    '  "suggestions": [',
    '    "Draft your weekly GTM update",',
    '    "Summarize competitor launches each Monday",',
    '    "Turn your notes into polished posts",',
    '    "Track your team\'s OKRs"',
    "  ]",
    "}",
    "",
    "Rules for \"claims\":",
    "- AT MOST 5 claims — the strongest, most useful ones only.",
    "- Each claim must be SHORT: a few words to one brief line. No multi-clause",
    "  sentences, no em-dash asides, no explanations. Think headline, not bio.",
    '  Good: "Contributed to Chirps (vector-DB security)". Bad: "You\'ve done',
    '  real work in vector database security — you contributed to Chirps, a',
    '  tool for scanning vector DBs for sensitive data".',
    "- Each claim independently true-or-false so I can remove ones that are wrong.",
    '- Phrase them directly ("You\'re…", "You climb outdoors", "Head of growth',
    '  at Vellum").',
    '- "confidence" is one of: "confident" (well supported by what you found),',
    '  "maybe" (plausible but unverified), "guessing" (a hunch from limited',
    "  signal).",
    '- "sources": 0–3 URLs you actually used as evidence for that specific',
    "  claim (the pages you read). Use [] for pure inferences.",
    "",
    "Rules for \"suggestions\":",
    "- EXACTLY 4 suggestions. These TEACH a brand-new user what you can do —",
    "  each should showcase a DIFFERENT capability of yours (e.g. research &",
    "  summarize, draft & write, automate a recurring task, analyze data,",
    "  build something), made relevant to my work and role.",
    "- Phrase each as a short, inviting action I can click to try right now,",
    '  starting with a verb (e.g. "Summarize this week\'s LLM releases for me",',
    '  "Draft a launch post from your notes"). No explanations.',
    "- Make them feel concrete and immediately runnable, not generic.",
    "",
    "Don't include anything sensitive or private. If you found very little,",
    'lean on "guessing" claims and broadly useful suggestions for my role.',
    "Output ONLY the JSON object — no code fence, no extra text.",
  ].join("\n");
}
