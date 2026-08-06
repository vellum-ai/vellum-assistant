import { VELLUM_COMMUNITY_URL } from "@/utils/external-urls";

/**
 * Turning a rejected auth flow into something a user can act on.
 *
 * Every auth entry point — the native splash form, the web login card, the
 * onboarding CTA — used to catch its failure and print one sentence:
 * "Something went wrong. Please try again." That sentence is correct for a
 * dropped connection and useless for everything else, and the flow's real
 * failure mode is everything else: the platform refusing the sign-in after
 * the IdP already accepted it. A user whose signup is closed, or whose Google
 * account was never linked to a Vellum account, retried forever against copy
 * that told them retrying would work.
 *
 * The native shells (`clients/ios/App/App/NativeAuthPlugin.swift`,
 * `clients/android/.../NativeAuthPlugin.java`) classify the platform's
 * response and reject with Capacitor's `code = "AUTH_ERROR"` plus
 * `data.authError` naming the cause. This module is the one place that turns
 * those causes into copy, so the three entry points cannot drift apart.
 */

/** Shown when nothing more specific is known — a transport failure, a bug. */
export const GENERIC_AUTH_ERROR_MESSAGE =
  "Something went wrong. Please try again.";

/**
 * Copy per `data.authError`. Keys are the codes the native shells emit:
 * `signup_closed` / `provider_signup` / `login_incomplete` from the platform
 * session exchange, plus whatever allauth names in a 400. Anything unlisted
 * falls back to {@link GENERIC_AUTH_ERROR_MESSAGE} — an unmapped code is a
 * missing entry here, never a crash.
 */
/** The community link as prose — displayed bare, without its scheme. */
const COMMUNITY_LINK_TEXT = VELLUM_COMMUNITY_URL.replace(/^https?:\/\//, "");

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  signup_closed: `Sign-ups are currently closed. Visit ${COMMUNITY_LINK_TEXT} to request access.`,
  provider_signup:
    "No Vellum account is linked to that login yet. Sign up first, then sign in.",
  login_incomplete:
    "Your account needs another step to finish signing in. Please sign in on the web, then try again.",
};

function errorProperty(err: unknown, key: string): unknown {
  if (typeof err !== "object" || err === null || !(key in err)) {
    return undefined;
  }
  return (err as Record<string, unknown>)[key];
}

/**
 * Capacitor's rejection `code` — the second argument to the native
 * `call.reject(message, code, …)`, surfaced as an own property rather than
 * inside `message`. Match it exactly; never substring-match the message.
 */
export function nativeAuthErrorCode(err: unknown): string | undefined {
  const code = errorProperty(err, "code");
  return typeof code === "string" ? code : undefined;
}

/**
 * True when the user dismissed the platform auth sheet. A routine dismissal,
 * not a failure: callers drop the loading state and show nothing.
 */
export function isUserCancelledAuthError(err: unknown): boolean {
  return nativeAuthErrorCode(err) === "USER_CANCELLED";
}

/**
 * The `data.authError` cause a native shell attached, if any.
 *
 * Also the right tag to report alongside the error: it is the difference
 * between a report that says "auth failed" and one that says which refusal
 * the platform issued.
 */
export function nativeAuthErrorDetail(err: unknown): string | undefined {
  if (nativeAuthErrorCode(err) !== "AUTH_ERROR") {
    return undefined;
  }
  const detail = errorProperty(errorProperty(err, "data"), "authError");
  return typeof detail === "string" && detail !== "" ? detail : undefined;
}

/** User-facing copy for a rejected auth flow. */
export function nativeAuthErrorMessage(err: unknown): string {
  const detail = nativeAuthErrorDetail(err);
  if (detail === undefined) {
    return GENERIC_AUTH_ERROR_MESSAGE;
  }
  return AUTH_ERROR_MESSAGES[detail] ?? GENERIC_AUTH_ERROR_MESSAGE;
}
