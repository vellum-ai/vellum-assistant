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

interface AuthContextType {
  isLoggedIn: boolean;
  isLoading: boolean;
  username: string | null;
  email: string | null;
  login: (username: string, password: string) => Promise<string | null>;
  signup: (username: string, email: string, password: string) => Promise<string | null>;
  logout: () => void;
  requestPasswordReset: (email: string, redirectTo: string) => Promise<string | null>;
  resetPassword: (newPassword: string, token: string) => Promise<string | null>;
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
        setUsername(data.user.name);
        setEmail(data.user.email);
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
    setUsername(user);
    const { data: sessionData } = await authClient.getSession();
    if (sessionData?.user?.email) {
      setEmail(sessionData.user.email);
    }
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
  }, []);

  const requestPasswordReset = useCallback(async (resetEmail: string, redirectTo: string): Promise<string | null> => {
    const { error } = await authClient.requestPasswordReset({
      email: resetEmail,
      redirectTo,
    });
    if (error) {
      return error.message ?? "Failed to send password reset email. Please try again.";
    }
    return null;
  }, []);

  const resetPassword = useCallback(async (newPassword: string, token: string): Promise<string | null> => {
    const { error } = await authClient.resetPassword({
      newPassword,
      token,
    });
    if (error) {
      return error.message ?? "Failed to reset password. Please try again.";
    }
    return null;
  }, []);

  return (
    <AuthContext.Provider
      value={{ isLoggedIn, isLoading, username, email, login, signup, logout, requestPasswordReset, resetPassword }}
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
