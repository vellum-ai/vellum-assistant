/**
 * Deslop rewrite dispatcher.
 *
 * Turns a block of page text into a plain-language rewrite by calling
 * the assistant's one-shot LLM endpoint (`POST /v1/inference/send`).
 * Self-hosted assistants are reached through the local gateway's
 * runtime-proxy catch-all; cloud assistants through the platform's
 * wildcard runtime proxy (`/v1/assistants/{id}/inference/send`).
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
 * Named profile requested for the rewrite. Installs without a usable
 * latency-optimized profile fall back to the assistant's own resolution.
 */
const DESLOP_PROFILE = "latency-optimized";

export function buildDeslopPrompt(text: string): string {
  return (
    "Rewrite the selected text without any jargon and speak coherently. " +
    "State it much more simply and concisely, like one human talking to another. " +
    "Be aggressive about cutting length: drop filler, hedging, repetition, and " +
    "needless detail, and keep only what the reader actually needs. " +
    "Aim for at most half the original length. " +
    `<selected_text>${text}</selected_text>`
  );
}

export type DeslopTarget =
  | { kind: "self-hosted"; gatewayUrl: string; pairToken: string | null }
  | { kind: "cloud"; environment: ExtensionEnvironment; assistantId: string };

interface InferenceSendResponse {
  response?: unknown;
}

type DeslopAttempt =
  | { ok: true; rewrite: string }
  | { ok: false; status: number; detail: string };

/**
 * Ask the assistant to rewrite `text`. Resolves to the rewritten text,
 * or throws with a message suitable for surfacing on the page.
 *
 * The rewrite asks for the latency-optimized profile. Installs where that
 * profile is missing or disabled answer 400 with a `Profile "..."` message,
 * which earns a single retry without the profile field.
 */
export async function requestDeslopRewrite(
  text: string,
  target: DeslopTarget,
): Promise<string> {
  const request = {
    message: buildDeslopPrompt(text),
    systemPrompt: DESLOP_SYSTEM_PROMPT,
  };

  let attempt = await attemptDeslopRewrite(
    target,
    JSON.stringify({ ...request, profile: DESLOP_PROFILE }),
  );
  if (!attempt.ok && isProfileRejection(attempt)) {
    attempt = await attemptDeslopRewrite(target, JSON.stringify(request));
  }

  if (!attempt.ok) {
    throw new Error(
      `Assistant rewrite failed (${attempt.status})${attempt.detail ? `: ${truncate(attempt.detail, 300)}` : ""}`,
    );
  }
  return attempt.rewrite;
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

async function attemptDeslopRewrite(
  target: DeslopTarget,
  body: string,
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
    throw new Error("Assistant returned an empty rewrite");
  }
  return { ok: true, rewrite: payload.response.trim() };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
