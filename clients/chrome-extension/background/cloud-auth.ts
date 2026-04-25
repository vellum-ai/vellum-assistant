/**
 * Cloud authentication for the Vellum Chrome extension.
 *
 * Handles WorkOS-based sign-in via `chrome.identity.launchWebAuthFlow`.
 * The flow opens a browser tab to the Vellum login page; after the user
 * authenticates, the platform redirects back to a `chromiumapp.org`
 * callback URL that Chrome intercepts, returning the final URL to the
 * extension.
 *
 * Post-login, the extension fetches the user's assistants from the
 * platform API to display in the popup.
 */

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
  /** Timestamp when the session was created. */
  createdAt: number;
}

export interface CloudAssistant {
  id: string;
  name: string;
  /** Optional avatar URL — not currently returned by the API. */
  avatarUrl?: string;
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
 * Opens the Vellum login page. After successful auth, the platform
 * redirects back to our chromiumapp.org callback URL. We store a
 * lightweight session and return it.
 *
 * The actual HTTP session cookie is set by Django's login flow and
 * attached to subsequent `fetch()` requests via `credentials: 'include'`.
 */
export async function startCloudLogin(
  environment: ExtensionEnvironment,
): Promise<CloudSession> {
  const { webBaseUrl } = cloudUrlsForEnvironment(environment);

  // The redirect URI that Chrome intercepts after login completes.
  const redirectUri = chrome.identity.getRedirectURL('cloud-auth');

  // Build the login URL. The platform's login page accepts a `returnTo`
  // query param. After successful WorkOS auth, Django redirects to
  // returnTo. We point returnTo at a lightweight JSON endpoint that
  // returns the user profile, which then redirects to our extension
  // callback.
  //
  // Flow: extension → /accounts/login?returnTo=/api/v1/me → WorkOS →
  //       Django callback → /api/v1/me → redirect to chromiumapp.org
  //
  // For now, use a simpler approach: open the login page with returnTo
  // pointing back to our redirect URI. After login, Django redirects
  // the browser to the redirectUri.
  const loginUrl = new URL('/accounts/login/', webBaseUrl);
  loginUrl.searchParams.set('returnTo', redirectUri);

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: loginUrl.toString(),
    interactive: true,
  });

  if (!resultUrl) {
    throw new Error('Login cancelled or failed — no redirect received.');
  }

  // After successful login, fetch user info from the platform API.
  // The session cookie was set by the login flow.
  const { apiBaseUrl } = cloudUrlsForEnvironment(environment);
  let email = 'signed in';

  try {
    const meResponse = await fetch(`${apiBaseUrl}/v1/user/`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (meResponse.ok) {
      const me = (await meResponse.json()) as { email?: string };
      if (me.email) {
        email = me.email;
      }
    }
  } catch {
    // Non-fatal: we still have a valid session, just can't get the email.
  }

  const session: CloudSession = {
    email,
    environment,
    createdAt: Date.now(),
  };
  await storeSession(session);
  return session;
}

// ── Assistants list ─────────────────────────────────────────────────

/**
 * Fetch the current user's assistants from the platform API.
 * Requires a valid session cookie (set during login).
 */
export async function fetchAssistants(
  environment: ExtensionEnvironment,
): Promise<CloudAssistant[]> {
  const { apiBaseUrl } = cloudUrlsForEnvironment(environment);

  const response = await fetch(`${apiBaseUrl}/api/assistants/`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch assistants (${response.status})`);
  }

  const data = (await response.json()) as {
    results?: Array<{ id: string; name: string }>;
  };

  if (!Array.isArray(data.results)) {
    return [];
  }

  return data.results.map((a) => ({
    id: a.id,
    name: a.name || 'Unnamed Assistant',
  }));
}
