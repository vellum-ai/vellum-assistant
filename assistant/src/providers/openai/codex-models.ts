/**
 * Model IDs Vellum allows through the ChatGPT Codex subscription endpoint
 * (`https://chatgpt.com/backend-api/codex`).
 *
 * `oauth_subscription` OpenAI connections hard-route every request to that
 * endpoint. Because unsupported model IDs return HTTP 400, this manually
 * maintained compatibility allowlist gates whether such a connection may
 * serve a given model during auto-resolution of an "Any active OpenAI
 * connection" profile.
 */
export const CODEX_SUBSCRIPTION_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]);

/** True when `model` is allowlisted for Codex subscription routing. */
export function isCodexSubscriptionModel(model: string): boolean {
  return CODEX_SUBSCRIPTION_MODEL_IDS.has(model);
}
