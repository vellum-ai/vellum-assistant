/**
 * Cloud authentication for the Vellum Chrome extension.
 *
 * Handles WorkOS sign-in via app-held PKCE, mirroring the macOS app. The
 * extension drives WorkOS User Management directly:
 *
 *   1. Discover the public WorkOS client id from the platform's headless
 *      allauth config (`/_allauth/app/v1/config`).
 *   2. Generate an S256 PKCE pair with Web Crypto.
 *   3. Authorize via `chrome.identity.launchWebAuthFlow`, which terminates on
 *      a `chromiumapp.org` redirect URL that Chrome intercepts and returns to
 *      the extension.
 *   4. Exchange the authorization code at WorkOS as a public client.
 *   5. Swap the WorkOS access token for a platform session token via allauth's
 *      headless provider-token endpoint (`meta.session_token`, the Django
 *      session key).
 *
 * The resulting session token is stored in `chrome.storage.local` and sent as
 * `X-Session-Token` on platform API calls (SameSite=Lax prevents session
 * cookies from being sent cross-site from the extension service worker).
 *
 * The legacy `/accounts/chrome-extension/start` Django endpoint is no longer
 * used by this client; it remains alive server-side for older extension
 * versions.
 */

import { fetchOrganizationId } from './cloud-api.js';
import type { ExtensionEnvironment } from './extension-environment.js';
import { cloudUrlsForEnvironment } from './extension-environment.js';
import {
  buildAuthorizeUrl,
  exchangeAccessTokenForSession,
  exchangeCodeWithWorkos,
  fetchWorkosClientId,
  generatePkcePair,
  generateState,
  parseRedirectUrl,
} from './workos-pkce.js';

/**
 * Path component of the `chromiumapp.org` redirect URI.
 *
 * Resolves to `https://<extension-id>.chromiumapp.org/cloud-auth`. This exact
 * URL MUST be registered as a redirect on the WorkOS User Management app per
 * environment — see this package's README "WorkOS redirect URIs" section.
 */
const REDIRECT_PATH = 'cloud-auth';

/**
 * Thrown when the user dismisses the auth window. `launchWebAuthFlow`'s
 * promise rejects (rather than resolving undefined) on cancel; callers
 * should treat this as a no-op rather than a login failure.
 */
export class CloudLoginCancelledError extends Error {
  constructor() {
    super('Login cancelled.');
    this.name = 'CloudLoginCancelledError';
  }
}

/** launchWebAuthFlow rejection messages that mean "user dismissed the window". */
const CANCEL_PATTERN = /did not approve|cancell?ed|closed the window/i;

// ── Storage keys ────────────────────────────────────────────────────

const SESSION_STORAGE_KEY = 'vellum.cloudSession';

// ── Types ───────────────────────────────────────────────────────────

export interface CloudSession {
  /** The user's display email (from WorkOS). */
  email: string;
  /** Environment the session was created against. */
  environment: ExtensionEnvironment;
  /** The user's active organization ID (first org from the API). */
  organizationId: string | null;
  /**
   * Allauth session token (= Django session key) obtained by exchanging the
   * WorkOS access token at the headless provider-token endpoint.  Sent as
   * X-Session-Token on platform API calls because SameSite=Lax prevents
   * session cookies from being sent cross-site from the extension service
   * worker.
   */
  sessionToken?: string;
  /** Timestamp when the session was created. */
  createdAt: number;
}

// ── Session persistence ─────────────────────────────────────────────

export async function getStoredSession(): Promise<CloudSession | null> {
  try {
    const result = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    const stored = result[SESSION_STORAGE_KEY];
    if (
      stored &&
      typeof stored === 'object' &&
      typeof (stored as Record<string, unknown>).email === 'string' &&
      typeof (stored as Record<string, unknown>).environment === 'string'
    ) {
      return stored as CloudSession;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

async function storeSession(session: CloudSession): Promise<void> {
  await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(SESSION_STORAGE_KEY);
}

// ── Selected assistant persistence ──────────────────────────────────

const SELECTED_ASSISTANT_KEY = 'vellum.selectedAssistant';

export interface SelectedAssistant {
  id: string;
  name: string;
}

export async function getSelectedAssistant(): Promise<SelectedAssistant | null> {
  try {
    const result = await chrome.storage.local.get(SELECTED_ASSISTANT_KEY);
    const stored = result[SELECTED_ASSISTANT_KEY];
    if (
      stored &&
      typeof stored === 'object' &&
      typeof (stored as Record<string, unknown>).id === 'string' &&
      typeof (stored as Record<string, unknown>).name === 'string'
    ) {
      return stored as SelectedAssistant;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

export async function storeSelectedAssistant(assistant: SelectedAssistant): Promise<void> {
  await chrome.storage.local.set({ [SELECTED_ASSISTANT_KEY]: assistant });
}

export async function clearSelectedAssistant(): Promise<void> {
  await chrome.storage.local.remove(SELECTED_ASSISTANT_KEY);
}

// ── Login flow ──────────────────────────────────────────────────────

/**
 * Initiate WorkOS sign-in via app-held PKCE.
 *
 * Discovers the public WorkOS client id, runs the PKCE authorize flow through
 * `chrome.identity.launchWebAuthFlow`, exchanges the code at WorkOS as a public
 * client, then swaps the access token for a platform session token. The session
 * token is stored and used as `X-Session-Token` on platform API calls.
 *
 * Mirrors the macOS app's `workos-pkce` flow; the redirect transport is a
 * `chromiumapp.org` URL Chrome intercepts rather than a loopback listener.
 */
export async function startCloudLogin(
  environment: ExtensionEnvironment,
): Promise<CloudSession> {
  const { apiBaseUrl } = cloudUrlsForEnvironment(environment);

  // The redirect URI Chrome intercepts when WorkOS redirects back. This exact
  // URL must be registered on the WorkOS UM app for `environment` — see README.
  const redirectUri = chrome.identity.getRedirectURL(REDIRECT_PATH);

  // 1. Discover the public WorkOS client id from the platform's headless config.
  const clientId = await fetchWorkosClientId(apiBaseUrl);

  // 2. Generate the PKCE pair and CSRF state.
  const { verifier, challenge } = await generatePkcePair();
  const state = generateState();

  // 3. Authorize via WorkOS in the browser; Chrome returns the redirect URL.
  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    redirectUri,
    challenge,
    state,
  });

  let resultUrl: string | undefined;
  try {
    resultUrl = await chrome.identity.launchWebAuthFlow({
      url: authorizeUrl,
      interactive: true,
    });
  } catch (err) {
    // The promise form rejects on cancel/error (it never resolves
    // undefined — that's the callback form). Surface a user-initiated
    // cancel distinctly so the caller treats it as a no-op.
    const message = err instanceof Error ? err.message : String(err);
    if (CANCEL_PATTERN.test(message)) {
      throw new CloudLoginCancelledError();
    }
    throw new Error(`Login failed: ${message}`);
  }

  // The promise form resolves a string on success; the typed signature
  // still permits undefined, so narrow it (and treat that as a cancel).
  if (!resultUrl) {
    throw new CloudLoginCancelledError();
  }

  // 4. Parse + verify the authorization code (state CSRF check inside).
  const { code } = parseRedirectUrl(resultUrl, state);

  // 5. Exchange the code at WorkOS as a public client → access token.
  const accessToken = await exchangeCodeWithWorkos({ clientId, code, verifier });

  // 6. Swap the WorkOS access token for a platform session token.
  const { sessionToken, email: exchangedEmail } =
    await exchangeAccessTokenForSession(apiBaseUrl, clientId, accessToken);

  let email = exchangedEmail ?? 'signed in';

  // Fall back to the allauth session API if the token exchange didn't include
  // an email (e.g. against older platform deployments).
  if (email === 'signed in') {
    try {
      const sessionResponse = await fetch(
        `${apiBaseUrl}/_allauth/browser/v1/auth/session`,
        {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        },
      );
      if (sessionResponse.ok) {
        const sessionData = (await sessionResponse.json()) as {
          data?: { user?: { email?: string } };
        };
        if (sessionData.data?.user?.email) {
          email = sessionData.data.user.email;
        }
      }
    } catch {
      // Non-fatal: we still have a valid session, just can't get the email.
    }
  }

  // Store the token immediately so cloudApiFetch can send X-Session-Token
  // on the upcoming /v1/organizations/ bootstrap call.  We update the stored
  // session with the org ID once we have it.
  const partialSession: CloudSession = {
    email,
    environment,
    organizationId: null,
    sessionToken,
    createdAt: Date.now(),
  };
  await storeSession(partialSession);

  // Resolve the user's organization ID for subsequent API calls.
  const organizationId = await fetchOrganizationId(environment);

  const session: CloudSession = { ...partialSession, organizationId };
  await storeSession(session);
  return session;
}


