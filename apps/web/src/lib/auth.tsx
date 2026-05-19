
import * as Sentry from "@sentry/react";
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  logout as allauthLogout,
  getSession,
} from "@/lib/account/allauth-fetch.js";
import {
  deleteBiometricToken,
  isBiometricEnabled,
  retrieveBiometricToken,
} from "@/lib/native-biometric.js";
import { installSessionCookies, isNativePlatform } from "@/lib/native-auth.js";
import { syncOnboardingUser } from "@/lib/onboarding/prefs.js";
import { setActiveOrganizationIdForRequests } from "@/lib/organization/organization-state.js";
import { deletePushTokenBestEffort } from "@/lib/push/unregister.js";

export interface AuthSessionUser {
  id?: string;
  username?: string;
  email?: string;
  is_staff?: boolean;
  first_name?: string;
  last_name?: string;
}

function getAuthSessionUserId(user: AuthSessionUser | null): string | null {
  return user?.id ?? user?.email ?? user?.username ?? null;
}

export function syncOrganizationStateForUser(
  previousUser: AuthSessionUser | null,
  nextUser: AuthSessionUser | null,
): void {
  const previousUserId = getAuthSessionUserId(previousUser);
  const nextUserId = getAuthSessionUserId(nextUser);

  if (!nextUserId || (previousUserId && previousUserId !== nextUserId)) {
    setActiveOrganizationIdForRequests(null);
  }
}

/**
 * Attach the authenticated user's stable id to the current Sentry scope
 * so future events carry `user.id` and Sentry can compute distinct
 * `userCount` per issue (needed for "N users affected" triage in
 * alert rules and Slack). Pass `id` only — never email or username —
 * to keep the diagnostics surface minimal for opted-in users.
 *
 * Reads `user?.id` directly. Deliberately does NOT reuse
 * `getAuthSessionUserId`'s email/username fallback: a user object
 * without an `id` is effectively unauthenticated for telemetry
 * purposes, and falling back to email or username would write PII
 * into Sentry as `user.id` — breaching the privacy contract this
 * function is supposed to uphold. Clear the Sentry user instead so
 * the next event reports as anonymous.
 *
 * `Sentry.setUser` writes to the current scope unconditionally; the
 * write is harmless when the Sentry client is closed because the user
 * has not consented to diagnostics (`vellum_share_diagnostics`), since
 * `Sentry.init` will not run and no event is ever serialized.
 *
 * See https://docs.sentry.io/platforms/javascript/enriching-events/identify-user/
 */
export function syncSentryUser(user: AuthSessionUser | null): void {
  Sentry.setUser(user?.id ? { id: user.id } : null);
}

interface AuthContextType {
  isLoggedIn: boolean;
  isLoading: boolean;
  isAdmin: boolean;
  userId: string | null;
  username: string | null;
  email: string | null;
  /**
   * The authenticated user's first name as provided by their social
   * provider (Apple, Google) on signup. Empty string when no name claim
   * was returned (e.g. email/password signup, or providers that did not
   * surface a given name).
   */
  firstName: string;
  /**
   * The authenticated user's last name as provided by their social
   * provider (Apple, Google) on signup. Empty string when no name claim
   * was returned.
   */
  lastName: string;
  logout: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const previousUserRef = useRef<AuthSessionUser | null>(null);

  const setUser = useCallback(
    (user: AuthSessionUser | null) => {
      const sessionUserId = getAuthSessionUserId(user);

      // Reconcile onboarding flags against the incoming user. `syncOnboardingUser`
      // persists the last-known user id in localStorage and clears the
      // `onboarding.*` flags whenever a different id signs in — covering both
      // the in-memory transition (session expiry → another user signs in
      // this tab) and the cold-start transition (fresh app load where the
      // previous user never logged out, so flags survived).
      syncOnboardingUser(sessionUserId);

      syncOrganizationStateForUser(previousUserRef.current, user);
      previousUserRef.current = user;

      syncSentryUser(user);

      setIsLoggedIn(!!user);
      setUserId(sessionUserId);
      setUsername(user?.username ?? null);
      setEmail(user?.email ?? null);
      setIsAdmin(user?.is_staff ?? false);
      setFirstName(user?.first_name ?? "");
      setLastName(user?.last_name ?? "");
    },
    [],
  );

  const refreshSession = useCallback(async (): Promise<boolean> => {
    const result = await getSession();
    if (result.ok && result.data.user) {
      setUser(result.data.user);
      return true;
    }

    // Attempt biometric recovery on foreground return when the session
    // has expired (e.g., the 2-week Django TTL elapsed while the app
    // was backgrounded). Same logic as initSession.
    if (isNativePlatform() && isBiometricEnabled()) {
      const token = await retrieveBiometricToken();
      if (token) {
        installSessionCookies(token);
        const recovered = await getSession();
        if (recovered.ok && recovered.data.user) {
          setUser(recovered.data.user);
          return true;
        }
        if (!recovered.ok && recovered.status !== undefined) {
          await deleteBiometricToken();
        }
      }
    }

    setUser(null);
    return false;
  }, [setUser]);

  useEffect(() => {
    // Observability for the "stuck on Checking your session..." class of
    // bugs: the only path that clears `isLoading` is `setIsLoading(false)`
    // inside this effect, so any hang or unhandled throw in `initSession`
    // strands the gate. Breadcrumbs trace which phase we reached; the
    // watchdog ships a Sentry event when we're still loading at 10s
    // (clear forensic signal without unsticking the UI). Sentry is
    // consent-gated at the SDK level (see `sentry-control.ts`); for users
    // without consent these calls are no-ops.
    let phase: string = "starting";
    const t0 = Date.now();
    const watchdog = setTimeout(() => {
      Sentry.captureMessage("auth.initSession stuck after 10s", {
        level: "warning",
        tags: { phase, platform: isNativePlatform() ? "native" : "web" },
        extra: { durationMs: Date.now() - t0 },
      });
    }, 10_000);
    const breadcrumb = (
      message: string,
      data?: Record<string, unknown>,
    ) => {
      phase = message;
      Sentry.addBreadcrumb({
        category: "auth.init",
        message,
        level: "info",
        data: { ...data, durationMs: Date.now() - t0 },
      });
    };

    async function initSession() {
      breadcrumb("session.fetch.start");
      const result = await getSession();
      breadcrumb("session.fetch.end", {
        ok: result.ok,
        status: result.ok ? 200 : result.status,
        hasUser: result.ok && !!result.data.user,
      });
      if (result.ok && result.data.user) {
        setUser(result.data.user);
        setIsLoading(false);
        breadcrumb("init.complete", { outcome: "session_ok" });
        return;
      }

      // Session cookie is missing or expired. On native platforms with
      // biometric enabled, attempt to recover the session from the
      // Keychain — this prompts Face ID / Touch ID (with device
      // passcode fallback) and avoids a full WorkOS re-login.
      if (isNativePlatform() && isBiometricEnabled()) {
        breadcrumb("biometric.attempt.start");
        const token = await retrieveBiometricToken();
        breadcrumb("biometric.token.retrieved", { hasToken: !!token });
        if (token) {
          installSessionCookies(token);
          breadcrumb("biometric.session.fetch.start");
          const recovered = await getSession();
          breadcrumb("biometric.session.fetch.end", {
            ok: recovered.ok,
            status: recovered.ok ? 200 : recovered.status,
            hasUser: recovered.ok && !!recovered.data.user,
          });
          if (recovered.ok && recovered.data.user) {
            setUser(recovered.data.user);
            setIsLoading(false);
            breadcrumb("init.complete", { outcome: "biometric_recovered" });
            return;
          }
          // Only delete the token when the server actually rejected it
          // (status is defined). A missing status means a network error
          // — the token may still be valid once connectivity returns.
          if (!recovered.ok && recovered.status !== undefined) {
            await deleteBiometricToken();
          }
        }
      }

      setUser(null);
      setIsLoading(false);
      breadcrumb("init.complete", { outcome: "no_session" });
    }
    initSession()
      .catch((err) => {
        // Surface the throw to Sentry so a stuck gate caused by an
        // unhandled rejection is attributable; rethrow as an unhandled
        // rejection to preserve existing behavior (we are not adding a
        // recovery path here — just observability).
        Sentry.captureException(err, { tags: { context: "auth.initSession", phase } });
        throw err;
      })
      .finally(() => {
        clearTimeout(watchdog);
      });

    return () => {
      clearTimeout(watchdog);
    };
  }, [setUser]);

  // Revalidate session on window focus / visibility change
  useEffect(() => {
    const onFocus = () => refreshSession();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshSession();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshSession]);

  // Cross-tab auth state sync via BroadcastChannel
  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("auth");
    channelRef.current = channel;
    channel.onmessage = () => {
      refreshSession();
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [refreshSession]);

  const broadcastAuthChange = useCallback(() => {
    channelRef.current?.postMessage("auth-changed");
  }, []);

  const logout = useCallback(async () => {
    try {
      // Best-effort APNs token DELETE. Runs BEFORE `allauthLogout()` so
      // the session cookie is still valid when the platform-side
      // `AssistantAPIKeyAuthentication` validates the request. The helper
      // self-guards on null state and self-swallows network errors, so
      // logout cannot be blocked by an unreachable platform.
      await deletePushTokenBestEffort();
      await allauthLogout();
    } finally {
      // Delete the Keychain token (the session it references is now
      // invalidated). Preserve the biometric *preference* so the user
      // doesn't have to re-enable it after their next login.
      await deleteBiometricToken();
      // Onboarding flags are reconciled inside `setUser` via
      // `syncOnboardingUser`, which clears stale flags only when a *different*
      // user id signs in next. Keeping them intact through a same-user
      // logout/login roundtrip avoids re-onboarding the same user.
      setUser(null);
      broadcastAuthChange();
    }
  }, [setUser, broadcastAuthChange]);

  return (
    <AuthContext
      value={{
        isLoggedIn,
        isLoading,
        isAdmin,
        userId,
        username,
        email,
        firstName,
        lastName,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
