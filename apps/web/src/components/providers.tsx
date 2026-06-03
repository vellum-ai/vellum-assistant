/**
 * Root provider composition for the web SPA.
 *
 * Wraps the app in auth-scoped → org-scoped QueryClients so that
 * switching users or orgs yields a fresh React Query cache instead of
 * leaking stale data.
 *
 * Only third-party library providers (React Query, Radix Tooltip) belong
 * here. App state uses Zustand stores — see `src/stores/`.
 *
 * Reference: https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@vellum/design-library";
import { useState, type ReactNode } from "react";

import { useAuthStore, useIsAuthenticated } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
      },
    },
  });
}

function AuthScopedQueryClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [queryClient] = useState(() => createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function RequestScopedQueryClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [queryClient] = useState(() => createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function ScopeKeyedQueryClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  const isAuthenticated = useIsAuthenticated();
  const user = useAuthStore.use.user();
  const currentOrganizationId =
    useOrganizationStore.use.currentOrganizationId();
  const scopeKey = `${
    isAuthenticated ? `user:${user?.id ?? "unknown"}` : "anonymous"
  }:org:${currentOrganizationId ?? "none"}`;

  return (
    <RequestScopedQueryClientProvider key={scopeKey}>
      {children}
    </RequestScopedQueryClientProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const user = useAuthStore.use.user();
  const authScopeKey = isAuthenticated
    ? `user:${user?.id ?? "unknown"}`
    : "anonymous";

  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={300}>
      <AuthScopedQueryClientProvider key={authScopeKey}>
        <ScopeKeyedQueryClientProvider>
          {children}
        </ScopeKeyedQueryClientProvider>
      </AuthScopedQueryClientProvider>
    </TooltipProvider>
  );
}
