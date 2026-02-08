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
  login: (username: string, password: string) => Promise<boolean>;
  signup: (username: string, email: string, password: string) => Promise<boolean>;
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

  useEffect(() => {
    authClient.getSession().then(({ data }) => {
      if (data?.user) {
        setIsLoggedIn(true);
        setUsername(data.user.name);
      }
      setIsLoading(false);
    });
  }, []);

  const login = useCallback(async (user: string, password: string): Promise<boolean> => {
    const { error } = await authClient.signIn.username({
      username: user,
      password,
    });
    if (error) {
      return false;
    }
    setIsLoggedIn(true);
    setUsername(user);
    return true;
  }, []);

  const signup = useCallback(async (user: string, email: string, password: string): Promise<boolean> => {
    const { error } = await authClient.signUp.email({
      name: user,
      username: user,
      email,
      password,
    });
    if (error) {
      return false;
    }
    setIsLoggedIn(true);
    setUsername(user);
    return true;
  }, []);

  const logout = useCallback(async () => {
    await authClient.signOut();
    setIsLoggedIn(false);
    setUsername(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ isLoggedIn, isLoading, username, login, signup, logout }}
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
