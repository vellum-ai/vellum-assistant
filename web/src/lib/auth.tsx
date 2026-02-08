"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

interface AuthContextType {
  isLoggedIn: boolean;
  isLoading: boolean;
  username: string | null;
  login: (username: string, password: string) => boolean;
  signup: (username: string, password: string) => boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const STORAGE_KEY = "vellum_auth";

interface AuthProviderProps {
  children: ReactNode;
}

interface StoredAuth {
  isLoggedIn: boolean;
  username: string;
}

function getStoredAuth(): StoredAuth | null {
  if (typeof window === "undefined") {
    return null;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored);
    if (parsed.isLoggedIn && parsed.username) {
      return parsed as StoredAuth;
    }
    return null;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [storedAuth, setStoredAuth] = useState<StoredAuth | null>(() => getStoredAuth());
  const isLoading = false; // Auth state is loaded synchronously on mount
  const isLoggedIn = storedAuth?.isLoggedIn ?? false;
  const username = storedAuth?.username ?? null;

  const login = useCallback((user: string, password: string): boolean => {
    if (user && password) {
      const auth = { isLoggedIn: true, username: user };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
      setStoredAuth(auth);
      return true;
    }
    return false;
  }, []);

  const signup = useCallback((user: string, password: string): boolean => {
    if (user && password) {
      const auth = { isLoggedIn: true, username: user };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
      setStoredAuth(auth);
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setStoredAuth(null);
  }, []);

  return (
    <AuthContext.Provider value={{ isLoggedIn, isLoading, username, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
