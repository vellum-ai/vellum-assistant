/**
 * Cloud authentication for the Vellum Chrome extension.
 *
 * Handles WorkOS-based sign-in via `chrome.identity.launchWebAuthFlow`.
 * The flow opens a browser tab to the Vellum Chrome extension login
 * endpoint; after the user authenticates, the platform redirects back
 * to a `chromiumapp.org` callback URL that Chrome intercepts, returning
 * the final URL (with token fragment) to the extension.
 *
 * The existing Django endpoint at `/accounts/chrome-extension/start`
 * handles the full flow: login → assistant ownership check → guardian
 * token mint → redirect with token. However, it requires an
 * `assistant_id` upfront, so the login flow is two-phase:
 *
 *   1. Fetch assistants via the headless allauth session API
 *   2. User picks an assistant in the popup
 *   3. `launchWebAuthFlow` with the selected assistant_id
 *
 * For now, we use a simpler approach: `launchWebAuthFlow` opens the
 * platform login page. After auth completes, the extension's session
 * cookie grants access to the assistants API. The popup then shows the
 * assistant picker.
 */

import { fetchOrganizationId } from './cloud-api.js';
import type { ExtensionEnvironment } from './extension-environment.js';
import { cloudUrlsForEnvironment } from './extension-environment.js';

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
   * Allauth session token (= Django session key) returned by the OAuth
   * callback in the URL fragment.  Sent as X-Session-Token on platform API
   * calls because SameSite=Lax prevents session cookies from being sent
   * cross-site from the extension service worker.
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
 * Initiate WorkOS login via `chrome.identity.launchWebAuthFlow`.
 *
 * Uses the existing `/accounts/chrome-extension/start` Django endpoint
 * which handles: login_required → WorkOS OAuth → session → redirect
 * back to the chromiumapp.org callback URL with auth result.
 *
 * We pass `redirect_uri` and `client_id` as required by the endpoint.
 * Since we don't have an `assistant_id` yet (user hasn't picked one),
 * we omit it — the endpoint will return an error fragment, but the
 * important thing is the user's Django session is now authenticated.
 * We catch the error and proceed to fetch assistants.
 */
export async function startCloudLogin(
  environment: ExtensionEnvironment,
): Promise<CloudSession> {
  const { apiBaseUrl } = cloudUrlsForEnvironment(environment);

  // The redirect URI that Chrome intercepts after the flow completes.
  const redirectUri = chrome.identity.getRedirectURL('cloud-auth');

  // Build the login URL using the Django chrome-extension start endpoint.
  // The endpoint lives on the API host (Django), not the web frontend.
  // Flow: Django @login_required → WorkOS OAuth → redirect back → validate
  //       → redirect to chromiumapp.org callback URL.
  const loginUrl = new URL('/accounts/chrome-extension/start', apiBaseUrl);
  loginUrl.searchParams.set('redirect_uri', redirectUri);
  loginUrl.searchParams.set('client_id', 'vellum-chrome-extension');

  let resultUrl: string | undefined;
  try {
    resultUrl = await chrome.identity.launchWebAuthFlow({
      url: loginUrl.toString(),
      interactive: true,
    });
  } catch (err) {
    throw new Error(
      `Login failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!resultUrl) {
    throw new Error('Login was cancelled.');
  }

  // The result URL may contain an error fragment (e.g. missing_assistant_id)
  // because we didn't pass assistant_id. That's fine — the user's session
  // is now authenticated. Parse the session token and email from the fragment.
  const fragment = new URL(resultUrl).hash.slice(1);
  const fragmentParams = new URLSearchParams(fragment);

  // Check for auth-level errors (not missing_assistant_id, which is expected)
  const error = fragmentParams.get('error');
  if (error && error !== 'missing_assistant_id') {
    const desc = fragmentParams.get('error_description') ?? error;
    throw new Error(`Login failed: ${desc}`);
  }

  // The OAuth callback returns the allauth session token and user email in
  // the fragment.  The token is required because SameSite=Lax session cookies
  // are not sent cross-site from the extension service worker.
  const sessionToken = fragmentParams.get('session_token') ?? undefined;
  let email = fragmentParams.get('email') ?? 'signed in';

  // Fall back to the allauth session API if the fragment didn't include an
  // email (e.g. against older platform deployments).
  if (email === 'signed in') {
    try {
      const sessionResponse = await fetch(`${apiBaseUrl}/_allauth/browser/v1/auth/session`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
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


