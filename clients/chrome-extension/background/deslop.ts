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

export function buildDeslopPrompt(text: string): string {
  return (
    "Rewrite the selected text without any jargon and speak coherently. " +
    "State it more simply and concisely, like one human talking to another. " +
    `<selected_text>${text}</selected_text>`
  );
}

export type DeslopTarget =
  | { kind: "self-hosted"; gatewayUrl: string; pairToken: string | null }
  | { kind: "cloud"; environment: ExtensionEnvironment; assistantId: string };

interface InferenceSendResponse {
  response?: unknown;
}

/**
 * Ask the assistant to rewrite `text`. Resolves to the rewritten text,
 * or throws with a message suitable for surfacing on the page.
 */
export async function requestDeslopRewrite(
  text: string,
  target: DeslopTarget,
): Promise<string> {
  const body = JSON.stringify({
    message: buildDeslopPrompt(text),
    systemPrompt: DESLOP_SYSTEM_PROMPT,
  });

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
    throw new Error(
      `Assistant rewrite failed (${response.status})${detail ? `: ${truncate(detail, 300)}` : ""}`,
    );
  }

  const payload = (await response.json()) as InferenceSendResponse;
  if (typeof payload.response !== "string" || payload.response.trim().length === 0) {
    throw new Error("Assistant returned an empty rewrite");
  }
  return payload.response.trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
