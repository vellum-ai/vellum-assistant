/**
 * Builds the "Day 2 Check-in" message sent to a fresh conversation once the
 * user connects Google Calendar on the check-in onboarding page.
 *
 * SPIKE — checkin-onboarding flow.
 *
 * Unlike the research prompt (which is auto-sent into the main onboarding
 * conversation), this prompt is fired into its OWN dedicated conversation by
 * `scheduleCheckin` the moment the calendar OAuth grant succeeds. The assistant
 * then pulls the user's calendar and books an "Assistant <> Human check-in"
 * event for tomorrow, embedding a deep link back into the app.
 *
 * The body is kept VERBATIM (locked typography, tested HTML-sanitization rules,
 * exact output contract). The only client-side substitutions are the two names
 * we know at onboarding time:
 *   - `{MY_NAME}`   → the user's collected name
 *   - `{YOUR_NAME}` → the assistant's display name
 * When a name is unknown we leave its placeholder token in place so the
 * prompt's documented "if unset, drop that side" title rules still apply. All
 * other placeholders ({GREETING_OPEN}, {UUID}, {URL_ENCODED_PROMPT}, …) are
 * resolved by the assistant per the "Default substitutions" instructions below.
 */

export interface CheckinSubject {
  /** The user's collected name. Omitted/blank → leave `{MY_NAME}` for the model. */
  userName?: string;
  /** The assistant's display name. Omitted/blank → leave `{YOUR_NAME}`. */
  assistantName?: string;
}

// Double-quoted lines so the prompt's many backticks and apostrophes stay
// literal; only embedded double quotes are escaped. Joined with newlines.
const CHECKIN_PROMPT_LINES: string[] = [
  'Create a "Day 2 Check-in" meeting for me on Google Calendar. Tomorrow, at a time that gives me the best chance of actually acting on it when I\'m notified — pull my calendar first and pick a 15-minute slot where I\'m free and not slammed. Bias toward evening if my calendar is wide open there; if a different window fits better (e.g., early morning before meetings stack up, late evening after the day\'s noise), take that. Don\'t book over back-to-back meetings.',
  "",
  'If I\'m not connected to Google, say "Skipped the check-in reminder because no calendar is connected" and stop. Same if OAuth is connected but the calendar scope wasn\'t granted.',
  "",
  'Title: `{MY_NAME} <> {YOUR_NAME}: Day 2 Check-in`. Locked typography — do not rename to "Day 2 Sync" or anything else. If my name is unset, drop that side: `{YOUR_NAME}: Day 2 Check-in`. If your name is unset: `{MY_NAME}: Day 2 Check-in`. If neither, just `Day 2 Check-in`.',
  "",
  "Description: HTML body, Gmail and Calendar will both sanitize.",
  "",
  "```html",
  "<p>👋 <strong>{GREETING_OPEN}.</strong></p>",
  "<p>{ONBOARDING_CONTEXT_LINE}, and I've already started learning <strong>{WHAT_I_WORK_ON}</strong>. This {DURATION} is the natural place to put that to work. I'll walk you through one thing I'd like to do for you this week.</p>",
  '<p><a href="https://www.vellum.ai/assistant/conversations/{UUID}?prompt={URL_ENCODED_PROMPT}"><strong>Let\'s go →</strong></a></p>',
  "<p>Click the link and we'll get started.</p>",
  "```",
  "",
  'Default substitutions on first run: greeting "Hi, it was great to meet you properly"; context "You just set me up"; what I work on "what you\'re working on"; duration "15 minutes"; prompt URL-encoded: `What%20would%20you%20recommend%20I%20tackle%20first%20this%20week%3F%20Propose%20it%20but%20wait%20for%20my%20go-ahead%20before%20doing%20anything`.',
  "",
  "HTML rules — Google Calendar strips nearly all styling, so don't rely on it. Tested and confirmed: inline `color`, `font-size`, `background`, `padding`, `border-radius` are all stripped, and external `<img>` is blocked entirely (even from google.com). What survives: `<p>`, `<br>`, `<strong>`, `<em>`, `<a>`, `<ul>`/`<li>`, `<hr>`, emoji. So: structure with plain tags, emphasis with `<strong>`, and make the CTA a bold link (`<a><strong>...</strong></a>`) — not a styled or colored button, because the color won't render. Keep it clean; skip emoji-as-color and character dividers (they read gimmicky). Brand expression belongs on the page the link opens, not in the event description.",
  "",
  "The CTA URL: `https://www.vellum.ai/assistant/conversations/{UUID}?prompt={URL_ENCODED_PROMPT}`. Generate the UUID fresh. URL-encode the prompt with `urllib.parse.quote` — single encode, no base64, no JSON escaping.",
  "",
  "When you create the event, I'm the organizer. Default no external attendees. sendUpdates `all` on this initial create.",
  "",
  "After it lands, output exactly:",
  "",
  "```",
  "Calendar: work|personal",
  "Time: ISO 8601 with timezone",
  "Attendees: count",
  "```",
];

const CHECKIN_PROMPT_TEMPLATE = CHECKIN_PROMPT_LINES.join("\n");

export function buildCheckinPrompt({
  userName,
  assistantName,
}: CheckinSubject): string {
  let prompt = CHECKIN_PROMPT_TEMPLATE;
  const myName = userName?.trim();
  const yourName = assistantName?.trim();
  if (myName) {
    prompt = prompt.replaceAll("{MY_NAME}", myName);
  }
  if (yourName) {
    prompt = prompt.replaceAll("{YOUR_NAME}", yourName);
  }
  return prompt;
}
