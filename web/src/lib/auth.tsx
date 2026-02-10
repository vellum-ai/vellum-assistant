"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { authClient } from "@/lib/auth-client";

type SessionUser = {
  id?: string | null;
  username?: string | null;
  email?: string | null;
};

function getSessionUsername(user: SessionUser): string | null {
  return user.username?.trim() || user.id?.trim() || null;
}

interface AuthContextType {
  isLoggedIn: boolean;
  isLoading: boolean;
  username: string | null;
  email: string | null;
  login: (username: string, password: string) => Promise<string | null>;
  signup: (username: string, email: string, password: string) => Promise<string | null>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [username, setUsername] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    authClient.getSession().then(({ data }) => {
      if (data?.user) {
        setIsLoggedIn(true);
        const sessionUser = data.user as SessionUser;
        setUsername(getSessionUsername(sessionUser));
        setEmail(sessionUser.email ?? null);
      }
      setIsLoading(false);
    });
  }, []);

  const login = useCallback(async (user: string, password: string): Promise<string | null> => {
    const { error } = await authClient.signIn.username({
      username: user,
      password,
    });
    if (error) {
      return error.message ?? "Login failed. Please try again.";
    }
    setIsLoggedIn(true);
    const { data: sessionData } = await authClient.getSession();
    const sessionUser = (sessionData?.user as SessionUser | undefined) ?? null;
    setUsername(sessionUser ? getSessionUsername(sessionUser) : user);
    setEmail(sessionUser?.email ?? null);
    return null;
  }, []);

  const signup = useCallback(async (user: string, signupEmail: string, password: string): Promise<string | null> => {
    const { error } = await authClient.signUp.email({
      name: user,
      username: user,
      email: signupEmail,
      password,
    });
    if (error) {
      return error.message ?? "Failed to create account. Please try again.";
    }
    setIsLoggedIn(true);
    setUsername(user);
    setEmail(signupEmail);
    return null;
  }, []);

  const logout = useCallback(async () => {
    await authClient.signOut();
    setIsLoggedIn(false);
    setUsername(null);
    setEmail(null);
    window.location.href = "/";
  }, []);

  return (
    <AuthContext.Provider
      value={{ isLoggedIn, isLoading, username, email, login, signup, logout }}
    >
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
