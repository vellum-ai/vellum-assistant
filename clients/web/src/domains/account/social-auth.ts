import type { Flow } from "@/generated/auth/types.gen";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/auth/csrf";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export interface SocialProvider {
  /** The allauth provider ID (e.g. "workos"). */
  id: string;
  /** Display label for the button. */
  label: string;
}

/** Intent to convey to the backend provider-redirect view. Determines WorkOS screen_hint. */
export type ProviderIntent = "login" | "signup";

/** Providers we currently surface in the UI. */
export const SOCIAL_PROVIDERS: SocialProvider[] = [
  { id: "workos", label: "Continue with WorkOS" },
];

/**
 * Stock redirect endpoint that delegates to specified provider.
 */
export const PROVIDER_REDIRECT_PATH =
  "/_allauth/browser/v1/auth/provider/redirect";

// ---------------------------------------------------------------------------
// Provider redirect (synchronous form POST)
// ---------------------------------------------------------------------------

export interface ProviderRedirectOptions {
  readonly intent?: ProviderIntent;
  /** Pre-fill the WorkOS AuthKit email field (and email-first flows). */
  readonly loginHint?: string;
}

/**
 * Build the form fields posted to the backend provider-redirect view.
 *
 * Extracted as a pure helper so the intent-plumbing behavior can be unit
 * tested without a DOM environment.
 */
export function buildProviderRedirectFields(
  providerId: string,
  callbackUrl: string,
  origin: string,
  options: ProviderRedirectOptions = {},
): Record<string, string> {
  const fields: Record<string, string> = {
    provider: providerId,
    callback_url: new URL(callbackUrl, origin).href,
    process: "login",
  };

  if (options.intent) {
    fields["intent"] = options.intent;
  }
  if (options.loginHint) {
    fields["login_hint"] = options.loginHint;
  }

  return fields;
}

/**
 * Assert that a CSRF token is present before kicking off a provider redirect.
 *
 * Extracted as a tiny pure helper so the assertion behavior can be unit tested
 * without a DOM environment. `ensureCsrfCookie()` swallows bootstrap failures
 * (see `@/lib/auth/csrf`), so without this guard we would silently POST to
 * `PROVIDER_REDIRECT_PATH` with no token and get a 403 back from Django — the
 * user would be stuck on the auth page with no feedback. Failing loudly here
 * surfaces the problem in the browser console instead.
 */
export function assertCsrfToken(
  token: string | null | undefined,
): asserts token is string {
  if (!token) {
    throw new Error(
      "Unable to start provider redirect: CSRF token is missing. The session may not be initialized. Please refresh the page and try again.",
    );
  }
}

/**
 * Kick off a provider redirect by submitting a hidden form.
 *
 * The endpoint at `PROVIDER_REDIRECT_PATH` expects an `application/x-www-form-urlencoded`
 * POST that results in a full-page redirect. It can't be done via XHR.
 */
export async function startProviderRedirect(
  providerId: string,
  callbackUrl: string,
  options: ProviderRedirectOptions = {},
): Promise<void> {
  await ensureCsrfCookie();

  // `ensureCsrfCookie()` swallows bootstrap failures, so we must verify a
  // token is actually available before building the form. Without this
  // guard, the POST to `PROVIDER_REDIRECT_PATH` would be rejected with 403
  // and the user would be stuck on the auth page.
  const csrfToken = getCsrfToken();
  assertCsrfToken(csrfToken);

  const origin = window.location.origin;
  const form = document.createElement("form");
  form.method = "POST";

  form.action = `${origin}${PROVIDER_REDIRECT_PATH}`;

  const fields = buildProviderRedirectFields(
    providerId,
    callbackUrl,
    origin,
    options,
  );
  fields["csrfmiddlewaretoken"] = csrfToken;

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

// ---------------------------------------------------------------------------
// Callback flow classification
// ---------------------------------------------------------------------------

export type CallbackOutcome =
  | { kind: "authenticated" }
  | { kind: "provider_signup" }
  | { kind: "error"; message: string };

/**
 * After a provider callback, classify the session state so the callback page
 * knows where to redirect.
 */
export function classifyCallbackFlows(
  isAuthenticated: boolean,
  pendingFlows: Flow[],
): CallbackOutcome {
  if (isAuthenticated) {
    return { kind: "authenticated" };
  }

  if (pendingFlows.some((f) => f.id === "provider_signup" && f.is_pending)) {
    return { kind: "provider_signup" };
  }

  return { kind: "error", message: "Unexpected authentication state." };
}
