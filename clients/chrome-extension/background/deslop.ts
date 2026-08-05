/**
 * Deslop inference dispatcher.
 *
 * Turns a block of page text into a plain-language rewrite, and answers
 * follow-up chat turns about the page, by calling the assistant's one-shot
 * LLM endpoint (`POST /v1/inference/send`). Self-hosted assistants are
 * reached through the local gateway's runtime-proxy catch-all; cloud
 * assistants through the platform's wildcard runtime proxy
 * (`/v1/assistants/{id}/inference/send`).
 */

import { cloudApiFetch } from "./cloud-api.js";
import type { ExtensionEnvironment } from "./extension-environment.js";

/**
 * Keeps the model's answer substitution-safe: the rewrite replaces the
 * clicked element's content verbatim, so commentary or quoting would
 * end up on the page.
 */
export const DESLOP_SYSTEM_PROMPT =
  "You rewrite text on behalf of the user. Reply with only the rewritten text. No preamble, no surrounding quotes, no commentary.";

/**
 * Governs the page-side chat thread, whose transcript interleaves rewrite
 * prompts, their rewrites, and free-form questions about the page.
 */
export const DESLOP_CHAT_SYSTEM_PROMPT =
  "You are assisting the user on a web page they are reading. " +
  "Earlier turns may contain requests to rewrite page text and your rewritten versions. " +
  "The user highlights parts of the page and asks questions or requests changes about them; " +
  "the highlighted part is marked with <user_highlighted> tags. " +
  "Answer directly, concisely, and conversationally, in plain text with no markdown formatting.";

/**
 * Named profile requested for the rewrite. Installs without a usable
 * latency-optimized profile fall back to the assistant's own resolution.
 */
const DESLOP_PROFILE = "latency-optimized";

/**
 * A single turn of the page-side chat thread, in the shape the daemon's
 * `messages` field expects.
 */
export interface DeslopTranscriptTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Serialized transcript budget. Well under the daemon's request cap, so a
 * long-running page session never fails on size alone.
 */
export const DESLOP_TRANSCRIPT_MAX_CHARS = 150_000;

export function buildDeslopPrompt(text: string): string {
  return (
    "Rewrite the selected text without any jargon and speak coherently. " +
    "State it much more simply and concisely, like one human talking to another. " +
    "Be aggressive about cutting length: drop filler, hedging, repetition, and " +
    "needless detail, and keep only what the reader actually needs. " +
    "Remove fluff and pleasantries entirely: no greetings, compliments, " +
    "apologies, or warm-up sentences. Start directly with the substance. " +
    "Aim for at most half the original length. " +
    `<selected_text>${text}</selected_text>`
  );
}

/**
 * Marks the part of the page the user had highlighted when they sent
 * `message`, so the model can tell page text from the user's own words.
 */
export function buildHighlightedUserTurn(
  highlighted: string,
  message: string,
): string {
  if (!highlighted) {
    return message;
  }
  return `<user_highlighted>${highlighted}</user_highlighted> ${message}`;
}

/**
 * Trim the transcript to `maxChars` of serialized JSON by dropping the
 * oldest turns in pairs, which keeps user/assistant alternation intact.
 * The most recent turns always survive.
 */
export function capTranscript(
  turns: DeslopTranscriptTurn[],
  maxChars: number,
): DeslopTranscriptTurn[] {
  let capped = turns;
  while (capped.length > 2 && JSON.stringify(capped).length > maxChars) {
    capped = capped.slice(2);
  }
  return capped;
}

export type DeslopTarget =
  | { kind: "self-hosted"; gatewayUrl: string; pairToken: string | null }
  | { kind: "cloud"; environment: ExtensionEnvironment; assistantId: string };

interface InferenceSendResponse {
  response?: unknown;
}

type DeslopAttempt =
  | { ok: true; reply: string }
  | { ok: false; status: number; detail: string };

/** Wording for the two failure modes, so each entry point reads naturally. */
interface DeslopErrorLabels {
  /** Prefixes the HTTP failure message, e.g. "Assistant rewrite failed". */
  failure: string;
  /** Thrown when the assistant answers with nothing usable. */
  empty: string;
}

/**
 * Ask the assistant to rewrite `text`. Resolves to the rewritten text,
 * or throws with a message suitable for surfacing on the page.
 */
export async function requestDeslopRewrite(
  text: string,
  target: DeslopTarget,
): Promise<string> {
  return sendDeslopRequest(
    target,
    {
      message: buildDeslopPrompt(text),
      systemPrompt: DESLOP_SYSTEM_PROMPT,
    },
    {
      failure: "Assistant rewrite failed",
      empty: "Assistant returned an empty rewrite",
    },
  );
}

/**
 * Continue the page-side chat thread. `transcript` is the full exchange so
 * far, ending with the turn the user just sent. Resolves to the reply text.
 */
export async function requestDeslopChat(
  transcript: DeslopTranscriptTurn[],
  target: DeslopTarget,
): Promise<string> {
  return sendDeslopRequest(
    target,
    {
      messages: transcript,
      systemPrompt: DESLOP_CHAT_SYSTEM_PROMPT,
    },
    {
      failure: "Assistant chat failed",
      empty: "Assistant returned an empty reply",
    },
  );
}

/**
 * Post an inference request and return the assistant's text.
 *
 * The request asks for the latency-optimized profile. Installs where that
 * profile is missing or disabled answer 400 with a `Profile "..."` message,
 * which earns a single retry without the profile field.
 */
async function sendDeslopRequest(
  target: DeslopTarget,
  request: Record<string, unknown>,
  labels: DeslopErrorLabels,
): Promise<string> {
  let attempt = await attemptDeslopSend(
    target,
    JSON.stringify({ ...request, profile: DESLOP_PROFILE }),
    labels,
  );
  if (!attempt.ok && isProfileRejection(attempt)) {
    attempt = await attemptDeslopSend(target, JSON.stringify(request), labels);
  }

  if (!attempt.ok) {
    throw new Error(
      `${labels.failure} (${attempt.status})${attempt.detail ? `: ${truncate(attempt.detail, 300)}` : ""}`,
    );
  }
  return attempt.reply;
}

/**
 * The daemon rejects an unusable profile with a message starting `Profile "`.
 * The quote arrives backslash-escaped when the message is wrapped in a JSON
 * error envelope, so both spellings count.
 */
const PROFILE_REJECTION_PATTERN = /Profile\s+\\?"/;

function isProfileRejection(
  attempt: Extract<DeslopAttempt, { ok: false }>,
): boolean {
  return (
    attempt.status === 400 && PROFILE_REJECTION_PATTERN.test(attempt.detail)
  );
}

async function attemptDeslopSend(
  target: DeslopTarget,
  body: string,
  labels: DeslopErrorLabels,
): Promise<DeslopAttempt> {
  let response: Response;
  if (target.kind === "self-hosted") {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (target.pairToken) {
      headers["authorization"] = `Bearer ${target.pairToken}`;
    }
    response = await fetch(
      `${target.gatewayUrl.replace(/\/$/, "")}/v1/inference/send`,
      { method: "POST", headers, body },
    );
  } else {
    response = await cloudApiFetch(
      target.environment,
      `/v1/assistants/${encodeURIComponent(target.assistantId)}/inference/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, detail };
  }

  const payload = (await response.json()) as InferenceSendResponse;
  if (typeof payload.response !== "string" || payload.response.trim().length === 0) {
    throw new Error(labels.empty);
  }
  return { ok: true, reply: payload.response.trim() };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
