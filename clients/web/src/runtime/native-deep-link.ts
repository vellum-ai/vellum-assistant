/**
 * Pure utilities for the Capacitor OAuth-completion deep link.
 *
 * On Capacitor iOS, integration OAuth runs inside `SFSafariViewController`.
 * Apple's prescribed pattern for round-tripping back into a host app from
 * SFSafariViewController is a custom URL scheme: redirecting
 * `window.location.href = "<scheme>://oauth-complete?…"` causes iOS to
 * dismiss the sheet and route the URL into the registered app via
 * `application(_:open:options:)`. Capacitor surfaces that as the
 * `appUrlOpen` listener event.
 *
 * Reference: https://capacitorjs.com/docs/apis/app#addlistenerappurlopen-
 */

import type { BillingCheckoutFlow } from "@/lib/event-bus";

export const OAUTH_COMPLETE_DEEP_LINK_EVENT = "vellum:oauth-complete-deeplink";
export const OAUTH_COMPLETE_DEEP_LINK_HOST = "oauth-complete";

export interface OAuthCompleteDeepLinkPayload {
  requestId: string;
  oauthStatus: string | null;
  oauthProvider: string | null;
  oauthCode: string | null;
}

declare global {
  interface WindowEventMap {
    "vellum:oauth-complete-deeplink": CustomEvent<OAuthCompleteDeepLinkPayload>;
  }
}

/**
 * Maps the popup-complete page's hostname to the matching iOS
 * `BUNDLE_URL_SCHEME` for that build target. Each iOS build target
 * sets an `ASSOCIATED_DOMAIN` and `BUNDLE_URL_SCHEME` pair in its xcconfig.
 */
const NATIVE_URL_SCHEME_BY_HOST: Record<string, string> = {
  "www.vellum.ai": "vellum-assistant",
  "vellum.ai": "vellum-assistant",
  "staging-assistant.vellum.ai": "vellum-assistant-staging",
  "dev-assistant.vellum.ai": "vellum-assistant-dev",
};

const ALLOWED_NATIVE_URL_PROTOCOLS = new Set(
  Object.values(NATIVE_URL_SCHEME_BY_HOST).map((scheme) => `${scheme}:`),
);

export function getNativeUrlSchemeForHost(host: string): string | null {
  return NATIVE_URL_SCHEME_BY_HOST[host] ?? null;
}

export const BILLING_CHECKOUT_COMPLETE_DEEP_LINK_HOST = "billing";
const BILLING_CHECKOUT_COMPLETE_PATH_SEGMENT = "checkout-complete";

/**
 * Stripe Checkout Session id shape (`cs_test_a1B2…` / `cs_live_…`). Mirrors
 * the platform's own check in `checkout_native_return.py` and the macOS main
 * parser, so a malformed id never reaches the billing route.
 */
const CHECKOUT_SESSION_ID_RE = /^cs_[A-Za-z0-9_]{1,255}$/;

export type BillingCheckoutCompleteDeepLinkPayload =
  | { status: "success"; sessionId: string; flow: BillingCheckoutFlow }
  | { status: "cancel"; sessionId: null; flow: BillingCheckoutFlow };

/**
 * Parse a `vellum-assistant://billing/checkout-complete?status=…&session_id=…`
 * deep link, the hand-off the platform bounces a `return_target=native`
 * Checkout to (`checkout_native_return.py`). An optional `flow=top_up` marks
 * a credit top-up checkout; anything else is a subscription checkout.
 *
 * Returns `null` for anything else — including a `success` without a
 * well-formed Session id, which the app can do nothing with. Semantics mirror
 * the macOS main-process parser so both shells agree.
 */
export function parseBillingCheckoutCompleteDeepLink(
  rawUrl: string,
): BillingCheckoutCompleteDeepLinkPayload | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!ALLOWED_NATIVE_URL_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  if (url.host !== BILLING_CHECKOUT_COMPLETE_DEEP_LINK_HOST) {
    return null;
  }
  const segment = url.pathname.replace(/^\/+/, "").split("/")[0];
  if (segment !== BILLING_CHECKOUT_COMPLETE_PATH_SEGMENT) {
    return null;
  }

  const flow: BillingCheckoutFlow =
    url.searchParams.get("flow") === "top_up" ? "top_up" : "subscription";

  const status = url.searchParams.get("status");
  if (status === "cancel") {
    return { status: "cancel", sessionId: null, flow };
  }
  const sessionId = url.searchParams.get("session_id") ?? "";
  if (status === "success" && CHECKOUT_SESSION_ID_RE.test(sessionId)) {
    return { status: "success", sessionId, flow };
  }
  return null;
}

/** Host segment shared with `VoiceModeDeepLink.swift` on the native side. */
const START_VOICE_DEEP_LINK_HOST = "voice";

/**
 * What a `<scheme>://voice` deep link asks the app to do.
 *
 * - `mode: "new"` — start a fresh live-voice session (default).
 * - `mode: "resume"` — bring an already-running session back on screen; falls
 *   back to `new` when nothing is running.
 * - `prompt` — free-form text the user already spoke before the app was up
 *   (Siri's `AskVellumIntent`). `null` whenever the link carries no usable
 *   prompt, which includes every prompt this parser rejects.
 */
interface StartVoiceDeepLinkPayload {
  mode: "new" | "resume";
  prompt: string | null;
}

/**
 * Longest `prompt` a start-voice deep link may carry. A spoken request is a
 * sentence or two; 2000 characters is far above any real utterance and far
 * below anything that could be used to push a wall of text into the app.
 */
export const MAX_START_VOICE_PROMPT_LENGTH = 2000;

/**
 * Control characters rejected outright in a `prompt`: C0 (`U+0000`-`U+001F`),
 * DEL and C1 (`U+007F`-`U+009F`), and the Unicode line separators
 * (`U+2028`/`U+2029`). None of them can appear in something a person said out
 * loud, so their presence means the link was hand-built rather than produced
 * by `AskVellumIntent` — reason enough to drop the text.
 */
const START_VOICE_PROMPT_CONTROL_CHARS_RE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Validate the `prompt` query parameter, returning `null` for anything the app
 * should not act on.
 *
 * Rejection is total, not a truncation: half of a question is a *different*
 * question, and silently asking the assistant a mangled version of what the
 * user said is worse than asking nothing and letting them retype. The link
 * still parses — the user did ask for voice — so an oversized prompt degrades
 * to a plain `mode=new` start rather than dropping the whole command.
 */
function sanitizeStartVoicePrompt(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  if (START_VOICE_PROMPT_CONTROL_CHARS_RE.test(raw)) {
    return null;
  }
  const prompt = raw.trim();
  if (prompt.length === 0 || prompt.length > MAX_START_VOICE_PROMPT_LENGTH) {
    return null;
  }
  return prompt;
}

/**
 * Parse a `vellum-assistant://voice?mode=new|resume&prompt=...` deep link — the
 * single native→SPA channel for "start talking".
 *
 * Every native producer targets this one URL shape: App Intents (Siri and the
 * Action Button), the Dynamic Island Live Activity's `widgetURL`, and manual
 * test links opened from Safari. New capabilities extend this parser rather
 * than adding a second mechanism — `prompt` is the first of them.
 *
 * Strict like the sibling parsers: the scheme must be an exact match against
 * {@link NATIVE_URL_SCHEME_BY_HOST}'s values — a `startsWith` check would let
 * `vellum-assistant-evil://voice` through — and the host must be exactly
 * `voice`. A missing or unrecognized `mode` degrades to `"new"`, the safe
 * interpretation of "the user asked for voice".
 *
 * `prompt` gets the strictest treatment of anything in this module because it
 * is the only free-form text on the surface, and a custom URL scheme is
 * openable by any other app or any web page. Bounds and character rules live
 * here rather than at the consumer so there is exactly one place where an
 * untrusted prompt becomes a trusted one — see {@link sanitizeStartVoicePrompt}.
 */
export function parseStartVoiceDeepLink(
  rawUrl: string,
): StartVoiceDeepLinkPayload | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!ALLOWED_NATIVE_URL_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  if (url.host !== START_VOICE_DEEP_LINK_HOST) {
    return null;
  }

  return {
    mode: url.searchParams.get("mode") === "resume" ? "resume" : "new",
    prompt: sanitizeStartVoicePrompt(url.searchParams.get("prompt")),
  };
}

export function buildOAuthCompleteDeepLink(
  scheme: string,
  payload: OAuthCompleteDeepLinkPayload,
): string {
  const params = new URLSearchParams();
  params.set("requestId", payload.requestId);
  if (payload.oauthStatus !== null) {
    params.set("oauth_status", payload.oauthStatus);
  }
  if (payload.oauthProvider !== null) {
    params.set("oauth_provider", payload.oauthProvider);
  }
  if (payload.oauthCode !== null) {
    params.set("oauth_code", payload.oauthCode);
  }
  return `${scheme}://${OAUTH_COMPLETE_DEEP_LINK_HOST}?${params.toString()}`;
}

/**
 * Parse a `vellum-assistant://oauth-complete?…` deep link payload.
 * Returns `null` for any URL that is not an OAuth-complete deep link.
 */
export function parseOAuthCompleteDeepLink(
  rawUrl: string,
): OAuthCompleteDeepLinkPayload | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!ALLOWED_NATIVE_URL_PROTOCOLS.has(url.protocol)) {
    return null;
  }

  if (url.host !== OAUTH_COMPLETE_DEEP_LINK_HOST) {
    return null;
  }

  const requestId = url.searchParams.get("requestId");
  if (!requestId) {
    return null;
  }

  return {
    requestId,
    oauthStatus: url.searchParams.get("oauth_status"),
    oauthProvider: url.searchParams.get("oauth_provider"),
    oauthCode: url.searchParams.get("oauth_code"),
  };
}
