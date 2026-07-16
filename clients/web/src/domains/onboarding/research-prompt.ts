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
  /**
   * The form's multi-select chips, verbatim. Kept as the array the user
   * actually picked rather than a pre-joined string: this is the shape the
   * onboarding-research telemetry event records, and chips are free-typed, so
   * a hobby containing a comma could not be split back out of a join. The
   * prompt's `", "` rendering is applied below, at the point of use.
   */
  hobbies?: string[];
  /**
   * IANA timezone of the user's browser (e.g. "America/Denver"). A soft
   * location signal the prompt's identity gate checks candidate matches
   * against; the line is omitted when absent.
   */
  timezone?: string;
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
function renderCapabilitiesBlock(
  capabilities: AvailableCapability[],
  includeSuggestions: boolean,
): string {
  const lines = capabilities
    .slice(0, MAX_INJECTED_CAPABILITIES)
    .map((c) => `- ${c.name} — ${c.description}`)
    .join("\n");
  if (!lines) return "";
  // The downstream keys this array precedes depend on whether suggestions are
  // requested, so the "before …" hint and the "don't reference setup" reminder
  // only name `suggestions` when that array is part of the shape.
  const beforeKeys = includeSuggestions
    ? 'before "claims" and "suggestions"'
    : 'before "claims"';
  const dontReference = includeSuggestions
    ? "Don't reference the setup in the claims or suggestions text."
    : "Don't reference the setup in the claims text.";
  return `
Capabilities you can offer me — specialized skillsets you can invoke on my behalf, not generic chat:
${lines}

Add a "plugins" array as the FIRST key in your JSON object, ${beforeKeys}: the 1-2 capabilities from the list above (exact names) that best fit who I am — judged by what you researched about my real role, stack, and day-to-day work. (Emit it first so setup can start while you finish the rest.) These get set up for me automatically as part of getting started, so pick by overall fit to ME, not to any single suggestion. Prefer fewer over forcing a match; use [] if nothing clearly fits. Example: "plugins": ["<exact name from the list above>"]. ${dontReference}
`;
}

export interface BuildResearchPromptOptions {
  /**
   * Whether to ask the model for clickable follow-up `suggestions`. The
   * suggestions-based final step is being retired in favor of the "Let's chat"
   * handoff (now always on), which installs the
   * picked plugins and drops the user straight into a primed chat. When false,
   * the prompt asks for ONLY `plugins` + `claims` and omits all suggestion
   * guidance. Defaults to true so the legacy suggestions flow is unchanged.
   */
  includeSuggestions?: boolean;
}

export function buildResearchPrompt(
  { firstName, lastName, occupation, hobbies, timezone }: ResearchSubject,
  availableCapabilities: AvailableCapability[] = [],
  { includeSuggestions = true }: BuildResearchPromptOptions = {},
): string {
  const fullName = [firstName.trim(), lastName.trim()]
    .filter(Boolean)
    .join(" ");
  const role = occupation.trim();
  const hobbyText = (hobbies ?? [])
    .map((h) => h.trim())
    .filter(Boolean)
    .join(", ");
  const timezoneText = timezone?.trim() ?? "";
  const capabilitiesBlock = renderCapabilitiesBlock(
    availableCapabilities,
    includeSuggestions,
  );
  // When capabilities are advertised, the canonical shape MUST show `plugins`
  // first — otherwise "respond with exactly this shape" (which the example
  // defines) would tell the model to omit it, and nothing gets installed.
  const pluginsExample = capabilitiesBlock
    ? `"plugins": ["<exact name from the list above>"], `
    : "";

  const statedDetails = [
    fullName ? `My name is ${fullName}.` : "",
    role ? `I work as ${role}.` : "",
    hobbyText ? `My hobby is ${hobbyText}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  // The timezone only augments real stated details — on an empty form the
  // fallback line must still win, not a bare timezone.
  const identity = statedDetails
    ? [statedDetails, timezoneText ? `My timezone is ${timezoneText}.` : ""]
        .filter(Boolean)
        .join(" ")
    : "I'd like you to get to know me before we start working together.";

  // The clickable-suggestions block is optional: the "Let's chat" final step
  // (now always on) installs the picked plugins and drops the
  // user into a primed chat instead, so it asks for only `plugins` + `claims`.
  const suggestionsArrayExample = includeSuggestions
    ? ` "suggestions": [ { "suggestion": "I'll find the 3 newest arXiv eval papers worth your time", "prompt": "Find me the 3 newest arXiv eval papers worth reading." }, { "suggestion": "I'll draft a crisp summary of the latest model-serving trade-offs", "prompt": "Draft me a short summary of the latest model-serving trade-offs." }, { "suggestion": "Connect GitHub and I'll triage your stalest issues", "prompt": "Connect to GitHub and triage my oldest open issues." }, { "suggestion": "I'll plan a weekend climbing trip near Boulder", "prompt": "Plan me a weekend climbing trip near Boulder." } ]`
    : "";
  const claimsExample = `"claims": [ { "claim": "Senior engineer at an AI infra startup", "confidence": "confident", "sources": ["https://linkedin.com/in/example-user", "https://example-infra.com/about"] }, { "claim": "Based in Boulder, CO", "confidence": "maybe", "sources": ["https://linkedin.com/in/example-user"] }, { "claim": "Into climbing and the outdoors", "confidence": "guessing", "sources": [] } ]`;
  const shapeExample = `{ ${pluginsExample}${claimsExample}${
    suggestionsArrayExample ? `,${suggestionsArrayExample}` : ""
  } }`;

  // Keep claims and (when present) suggestions aligned with the stated role.
  const alignedArtifacts = includeSuggestions
    ? "claims and suggestions"
    : "claims";

  const suggestionRules = includeSuggestions
    ? `Rules for "suggestions":

Each suggestion is an object with two fields:
"suggestion": the offer in YOUR voice (the assistant), exactly as it appears on the clickable card — first-person "I" refers to you (whatever your name). Pattern: "I'll [verb] [specific artifact]" or "Connect me to [integration] and I'll [verb] [artifact]." Lead with the offer; no intake question in front of it — you gather the details in the follow-up conversation after the click.
"prompt": the same offer re-voiced as the message sent on the user's behalf when they click, in the USER's first person ("I"/"my" = the user) — what they'd say to take you up on it (suggestion "I'll find you 3 papers" → prompt "Find me 3 papers worth reading"). State the request; don't echo the assistant-voiced wording and don't ask a question back.

Generate EXACTLY 4 suggestions covering four DIFFERENT capabilities, each making me think "wait, you can do that?" Draw on your range — a quick researched answer, a recurring brief or monitor, a doc drafted in a live editor, an integration (GitHub, Gmail, Calendar, Slack, Linear) connected with a first action, or a hobby hook if research surfaced one — but pick what genuinely fits; don't force a fixed set.
Ground every suggestion in what you actually learned about me — my real role, stack, industry, and (if given) hobby. Specific to me, not generic assistant stuff; skip bare "summarize" or "draft a post."
CRITICAL: every suggestion must be a fast win you can deliver in the first reply, never a long-running build. NEVER suggest building an app, dashboard, tool, site, or tracker, or any multi-step "build me a ___" project — those kill the first impression. The ambitious build can come later in the conversation, never on the first card.
Keep each SHORT and skimmable: under 10 words, ONE clause, ONE artifact, no lists of three ("X, Y, and Z"). The reader scans four cards in seconds — a long line loses them.
`
    : "";

  const closingFallback = includeSuggestions
    ? `Don't include anything sensitive or private. If the identity gate leaves you with very little, return only the honest "guessing" claims my stated details support, and lean on broadly useful suggestions for my role.`
    : `Don't include anything sensitive or private. If the identity gate leaves you with very little, return only the honest "guessing" claims my stated details support.`;

  return `${identity}

Get to know me. Search the web for what's publicly known about me, and infer a handful of things about who I am: what I do, my role, where I'm based, what I'm into, anything that would help you assist me better. Prefer sources people author about themselves — LinkedIn, a personal site, GitHub, an employer's team page, published work, public social profiles. Never fetch or cite people-search or background-check aggregators (Instant Checkmate, Spokeo, BeenVerified, TruePeopleSearch, Whitepages, and similar); data-broker directories (ZoomInfo, RocketReach, Apollo) may corroborate another source but must never be a claim's only basis.

IDENTITY GATE — decide who a page is about before you use it: a name match alone is NEVER enough to attribute a page to me. Attribute it to me only when it also corroborates something I stated — my role, my hobby, or a location consistent with my timezone if I gave one. If several people share my name and none clears that bar, or you find no verifiable match at all, then I have no public profile you can use: return ONLY inferences from what I stated above, each labeled "guessing" with "sources": []. An honest near-empty card beats a stranger's biography. If my details above read as placeholder or joke input rather than a real identity, skip the web search and return an empty claims array.

Treat the name, role, and hobby I provided above as first-party context from me. Use public sources to enrich that context, not to override or correct it. If public sources use a different title or omit part of my stated role, do not frame my stated role as wrong; mention the public title only as supporting nuance when it is useful, and keep ${alignedArtifacts} aligned with my stated role.

CRITICAL: your final reply must be ONLY a JSON object. No preamble, no explanation, no prose, nothing before or after it. Do your thinking and searching, then respond with exactly this shape and nothing else:

${shapeExample}

Rules for "claims":

AT MOST 5 claims, typically 3 to 4. Never pad the list or inflate a confidence tier to seem thorough.
Phrase each claim in third person as a short headline ("Senior engineer at an AI infra startup", "Based in Boulder, CO", "Active climber on Mountain Project"). No multi-clause sentences, no em-dash asides, no explanations. Good: "Contributed to Chirps (vector-DB security)". Bad: "You've done real work in vector database security. You contributed to Chirps, a tool for scanning vector DBs for sensitive data".
Each claim must be independently true-or-false so I can remove the ones that are wrong.
Every specific in a claim (employer, title, publication, city) must appear in a source you actually fetched this turn — never synthesize or embellish specifics a source doesn't state.
"confidence" is earned per the identity gate: "confident" needs 2+ independent gate-passing sources, "maybe" needs exactly one, and a claim with no sources is an inference from my stated details and must be "guessing".
"sources": 0 to 3 URLs you actually used as evidence for that specific claim. Use [] for pure inferences.
${suggestionRules}${capabilitiesBlock}
${closingFallback}
Keep every string value simple so the JSON always parses: one line, no line breaks inside a value, and NO double-quote characters inside a value — use single quotes (or none) for emphasis, quoted names, or tool names. Output ONLY the JSON object. No code fence, no extra text.`;
}
