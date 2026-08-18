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

/**
 * Query item the iOS shell adds to a command URL an App Intent produced, and
 * strips from every URL that arrived from outside the process (Safari,
 * another app, the Live Activity's tap). Name and value are shared with
 * `CommandURLProvenance.swift`, which owns the trust argument: intent URLs
 * are handed to the delegate in-process and never pass through
 * `application(_:open:)`, so by the time a URL reaches Capacitor's
 * `appUrlOpen` the marker is present exactly when an intent produced it.
 */
const COMMAND_URL_PROVENANCE_PARAM = "src";
const COMMAND_URL_PROVENANCE_INTENT = "intent";
/**
 * The marker as one raw query item, byte-for-byte what
 * `CommandURLProvenance.marked` serializes. It is matched against the raw
 * `&`-split query, never through `URLSearchParams`: that view percent-decodes
 * item names, so it would read `s%72c=intent` as the marker, and the shell
 * (Foundation, a different parser) has to strip every spelling this side
 * honors. The raw item is the one thing both parsers see identically, so it
 * is the whole predicate here; the shell strips it and its decoded spellings.
 */
const COMMAND_URL_PROVENANCE_ITEM = `${COMMAND_URL_PROVENANCE_PARAM}=${COMMAND_URL_PROVENANCE_INTENT}`;

/**
 * Where a command URL came from, as far as the shell can prove.
 *
 * - `"intent"`: an iOS App Intent produced it on the user's explicit action
 *   (a Shortcut, Siri, the Action Button). Text it carries may be acted on
 *   without a further tap.
 * - `null`: unknown, which for a custom URL scheme means "anyone". Text it
 *   carries is staged for the user to send, never sent.
 */
export type CommandUrlProvenance = "intent" | null;

/**
 * Whether a parser may honor the provenance marker at all. Only a shell that
 * strips the marker at its external entry points can vouch for it, and today
 * that is the iOS shell alone; the Capacitor source passes `true` only there.
 * Defaults to `false` so a new caller cannot trust the marker by omission.
 */
export interface DeepLinkParseOptions {
  acceptProvenance?: boolean;
}

function readProvenance(
  url: URL,
  options: DeepLinkParseOptions | undefined,
): CommandUrlProvenance {
  if (options?.acceptProvenance !== true) {
    return null;
  }
  // `url.search` is "" or "?…"; slicing the "?" off "" leaves no items.
  return url.search.slice(1).split("&").includes(COMMAND_URL_PROVENANCE_ITEM)
    ? "intent"
    : null;
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
  /** See {@link CommandUrlProvenance}; `null` unless the caller opted in. */
  provenance: CommandUrlProvenance;
}

/**
 * Longest `prompt` a start-voice deep link may carry. A spoken request is a
 * sentence or two; 2000 characters is far above any real utterance and far
 * below anything that could be used to push a wall of text into the app.
 */
export const MAX_START_VOICE_PROMPT_LENGTH = 2000;

/**
 * Control characters rejected outright in deep-link free text: C0
 * (`U+0000`-`U+001F`), DEL and C1 (`U+007F`-`U+009F`), and the Unicode line
 * separators (`U+2028`/`U+2029`). None of them can appear in something a
 * person said out loud, so their presence means the link was hand-built
 * rather than produced by an App Intent, reason enough to drop the text.
 */
const DEEP_LINK_TEXT_CONTROL_CHARS_RE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * The multiline variant: same classes minus tab, LF, and CR, which are
 * legitimate in *typed* text (a Shortcuts action's message field accepts
 * line breaks, unlike anything Siri transcribes).
 */
const DEEP_LINK_MULTILINE_TEXT_CONTROL_CHARS_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Validate a free-text deep-link parameter (a start-voice `prompt`, an
 * open-thread `message`), returning `null` for anything the app should not
 * act on. `multiline` selects the typed-text character rules and normalizes
 * CRLF / lone CR to LF so consumers see one line-break convention.
 *
 * Rejection is total, not a truncation: half of a question is a *different*
 * question, and silently sending the assistant a mangled version of what the
 * user said is worse than sending nothing and letting them retype. Callers
 * still parse the rest of the link, so oversized text degrades to the plain
 * form of the command (a `mode=new` voice start, an open-without-message)
 * rather than dropping the whole command.
 */
function sanitizeDeepLinkText(
  raw: string | null,
  maxLength: number,
  options?: { multiline?: boolean },
): string | null {
  if (raw === null) {
    return null;
  }
  const controlChars = options?.multiline
    ? DEEP_LINK_MULTILINE_TEXT_CONTROL_CHARS_RE
    : DEEP_LINK_TEXT_CONTROL_CHARS_RE;
  if (controlChars.test(raw)) {
    return null;
  }
  const text = (options?.multiline ? raw.replace(/\r\n?/g, "\n") : raw).trim();
  if (text.length === 0 || text.length > maxLength) {
    return null;
  }
  return text;
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
 * untrusted prompt becomes a trusted one; see {@link sanitizeDeepLinkText}.
 */
export function parseStartVoiceDeepLink(
  rawUrl: string,
  options?: DeepLinkParseOptions,
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
    prompt: sanitizeDeepLinkText(
      url.searchParams.get("prompt"),
      MAX_START_VOICE_PROMPT_LENGTH,
    ),
    provenance: readProvenance(url, options),
  };
}

/** Host segment shared with `ThreadDeepLink.swift` on the native side. */
const OPEN_THREAD_DEEP_LINK_HOST = "thread";

/**
 * What a `<scheme>://thread/<id>?message=...` deep link asks the app to do:
 * open the given conversation and, when `message` survives sanitization,
 * stage it in that conversation's composer.
 *
 * - `threadId` is the daemon conversation id from the path. The parser only
 *   checks its *shape*; whether it names a live conversation is the
 *   consumer's problem, resolved against live data.
 * - `message` is `null` whenever the link carries no usable text, which
 *   includes every message this parser rejects. The link still parses in
 *   that case: opening the chat the user picked beats dropping the whole
 *   command.
 */
interface OpenThreadDeepLinkPayload {
  threadId: string;
  message: string | null;
  /** See {@link CommandUrlProvenance}; `null` unless the caller opted in. */
  provenance: CommandUrlProvenance;
}

/**
 * Longest `message` an open-thread deep link may carry. Same ceiling as the
 * start-voice `prompt` and for the same reason: far above anything a person
 * writes into a Shortcuts action, far below a wall of text.
 */
export const MAX_OPEN_THREAD_MESSAGE_LENGTH = 2000;

/**
 * Conversation-id shape accepted in the path. Server ids are UUIDs; the
 * charset stays a little wider so an id-format change does not silently kill
 * the feature, while still rejecting separators, quotes, and anything that
 * could smuggle structure into a route.
 */
const OPEN_THREAD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Parse a `vellum-assistant://thread/<id>?message=...` deep link, produced by
 * the iOS `SendMessageToChatIntent` (LUM-3230) and shaped after the macOS
 * shell's `vellum://thread/<id>` link so the two schemes stay mirror images.
 *
 * Strict like the sibling parsers: exact scheme allowlist, exact host, and a
 * single well-formed path segment for the id. `message` gets the same
 * treatment as the start-voice `prompt` and for the same reason: it is
 * free-form text on a surface any app or web page can open, and the consumer
 * stages it in a conversation's composer, so this parser is the one place
 * where the untrusted text is bounded (see {@link sanitizeDeepLinkText};
 * the send itself stays with the user, per the consumer's caller-identity
 * note).
 */
export function parseOpenThreadDeepLink(
  rawUrl: string,
  options?: DeepLinkParseOptions,
): OpenThreadDeepLinkPayload | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!ALLOWED_NATIVE_URL_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  if (url.host !== OPEN_THREAD_DEEP_LINK_HOST) {
    return null;
  }

  const threadId = url.pathname.replace(/^\//, "");
  if (!OPEN_THREAD_ID_RE.test(threadId)) {
    return null;
  }

  return {
    threadId,
    message: sanitizeDeepLinkText(
      url.searchParams.get("message"),
      MAX_OPEN_THREAD_MESSAGE_LENGTH,
      { multiline: true },
    ),
    provenance: readProvenance(url, options),
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
