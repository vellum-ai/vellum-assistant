/**
 * Model IDs accepted by the ChatGPT Codex subscription endpoint
 * (`https://chatgpt.com/backend-api/codex`).
 *
 * `oauth_subscription` OpenAI connections hard-route every request to that
 * endpoint, which rejects any model outside this set with HTTP 400. The set
 * gates whether such a connection may serve a given model during auto-
 * resolution of an "Any active OpenAI connection" profile.
 */
export const CODEX_SUBSCRIPTION_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]);

/** True when `model` is accepted by the Codex subscription endpoint. */
export function isCodexSubscriptionModel(model: string): boolean {
  return CODEX_SUBSCRIPTION_MODEL_IDS.has(model);
}
