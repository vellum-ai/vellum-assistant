/**
 * Authentication context for the web SPA.
 *
 * Probes the Django/allauth session on mount, re-validates on window focus
 * and visibility changes, and synchronizes logout across tabs via
 * BroadcastChannel.
 *
 * Reference: https://docs.allauth.org/en/latest/headless/openapi-specification/
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  getSession,
  logout as allauthLogout,
} from "@/lib/auth/allauth-client.js";
import { setActiveOrganizationIdForRequests } from "@/domains/organization/organization-state.js";

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

function syncOrganizationStateForUser(
  previousUser: AuthSessionUser | null,
  nextUser: AuthSessionUser | null,
): void {
  const previousUserId = getAuthSessionUserId(previousUser);
  const nextUserId = getAuthSessionUserId(nextUser);

  if (!nextUserId || (previousUserId && previousUserId !== nextUserId)) {
    setActiveOrganizationIdForRequests(null);
  }
}

interface AuthContextType {
  isLoggedIn: boolean;
  isLoading: boolean;
  isAdmin: boolean;
  userId: string | null;
  username: string | null;
  email: string | null;
  firstName: string;
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
      syncOrganizationStateForUser(previousUserRef.current, user);
      previousUserRef.current = user;

      setIsLoggedIn(!!user);
      setUserId(getAuthSessionUserId(user));
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

    setUser(null);
    return false;
  }, [setUser]);

  useEffect(() => {
    let cancelled = false;
    async function initSession() {
      const result = await getSession();
      if (cancelled) return;
      if (result.ok && result.data.user) {
        setUser(result.data.user);
        setIsLoading(false);
        return;
      }

      setUser(null);
      setIsLoading(false);
    }
    initSession().catch((err) => {
      if (cancelled) return;
      console.error("auth.initSession failed", err);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  useEffect(() => {
    const safeRefresh = () =>
      refreshSession().catch((err) =>
        console.warn("auth.refreshSession failed", err),
      );
    const onFocus = () => safeRefresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") safeRefresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshSession]);

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
      await allauthLogout();
    } finally {
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
