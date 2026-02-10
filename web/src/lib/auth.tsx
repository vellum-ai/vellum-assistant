"use client";

import {
  createContext,
  ReactNode,
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

interface LoginResult {
  error: string | null;
  emailNotVerified?: boolean;
}

interface AuthContextType {
  isLoggedIn: boolean;
  isLoading: boolean;
  username: string | null;
  email: string | null;
  login: (username: string, password: string) => Promise<LoginResult>;
  signup: (username: string, email: string, password: string) => Promise<string | null>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
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

  const login = async (user: string, password: string): Promise<LoginResult> => {
    const { error } = await authClient.signIn.username({
      username: user,
      password,
    });
    if (error) {
      if (error.code === "EMAIL_NOT_VERIFIED") {
        return { error: null, emailNotVerified: true };
      }
      return { error: error.message ?? "Invalid username or password." };
    }
    setIsLoggedIn(true);
    const { data: sessionData } = await authClient.getSession();
    const sessionUser = (sessionData?.user as SessionUser | undefined) ?? null;
    setUsername(sessionUser ? getSessionUsername(sessionUser) : user);
    setEmail(sessionUser?.email ?? null);
    return { error: null };
  };

  const signup = async (user: string, signupEmail: string, password: string): Promise<string | null> => {
    const { error } = await authClient.signUp.email({
      name: user,
      username: user,
      email: signupEmail,
      password,
    });
    if (error) {
      return error.message ?? "Failed to create account. Please try again.";
    }
    return null;
  };

  const logout = async () => {
    await authClient.signOut();
    setIsLoggedIn(false);
    setUsername(null);
    setEmail(null);
    window.location.href = "/";
  };

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
