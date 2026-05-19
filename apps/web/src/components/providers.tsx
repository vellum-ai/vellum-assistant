/**
 * Root provider composition for the web SPA.
 *
 * Wraps the app in Auth → Organization → scope-keyed QueryClient so that:
 * 1. Auth state is available to all descendants.
 * 2. Organization context resolves the active org for API headers.
 * 3. The React Query cache is keyed by (user, org) — switching users or
 *    orgs yields a fresh cache instead of leaking stale data.
 *
 * Reference: https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { useAuth } from "@/lib/auth/auth-provider.js";
import {
  OrganizationProvider,
  useOrganization,
} from "@/domains/organization/organization-provider.js";

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
  const { isLoggedIn, userId } = useAuth();
  const { currentOrganizationId } = useOrganization();
  const scopeKey = `${
    isLoggedIn ? `user:${userId ?? "unknown"}` : "anonymous"
  }:org:${currentOrganizationId ?? "none"}`;

  return (
    <RequestScopedQueryClientProvider key={scopeKey}>
      {children}
    </RequestScopedQueryClientProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const { isLoggedIn, userId } = useAuth();
  const authScopeKey = isLoggedIn
    ? `user:${userId ?? "unknown"}`
    : "anonymous";

  return (
    <AuthScopedQueryClientProvider key={authScopeKey}>
      <OrganizationProvider>
        <ScopeKeyedQueryClientProvider>
          {children}
        </ScopeKeyedQueryClientProvider>
      </OrganizationProvider>
    </AuthScopedQueryClientProvider>
  );
}
