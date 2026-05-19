
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ReactNode, useState } from "react";

import { useAuth } from "@/lib/auth.js";
import { OrganizationProvider, useOrganization } from "@/lib/organization/organization-provider.js";

// Importing this has the side effect of configuring the default HeyAPI `fetch` client.
// This handles stuff like CSRF and passing the `Vellum-Organization-Id` header.
// Consumers of the query client should not need to import this.
import "@/lib/vellum-api/client.js";

interface AppProvidersProps {
  children: ReactNode;
}

interface AuthScopedQueryClientProviderProps {
  children: ReactNode;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // react-query's default caching strategy is quite different from RTKQ.
        // RTKQ will cache queries with the same keys and *not* refetch unless
        // 1. the key was invalidated somehow
        // 2. there are no more subscribers to that data, and `keepUnusedFor` time period has elapsed.
        // https://redux-toolkit.js.org/rtk-query/usage/cache-behavior#default-cache-behavior
        // On the other hand, react-query treats all data as stale by default,
        // and will immediately refetch.
        // https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults
        // I arbitrarily adjusted staleness threshold here to 10 seconds.
        staleTime: 10_000,
      },
    },
  });
}

function AuthScopedQueryClientProvider({
  children,
}: AuthScopedQueryClientProviderProps) {
  const [queryClient] = useState(() => createQueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

interface RequestScopedQueryClientProviderProps {
  children: ReactNode;
}

function RequestScopedQueryClientProvider({
  children,
}: RequestScopedQueryClientProviderProps) {
  const [queryClient] = useState(() => createQueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function ScopeKeyedQueryClientProvider({
  children,
}: RequestScopedQueryClientProviderProps) {
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

export function AppProviders({ children }: AppProvidersProps) {
  const { isLoggedIn, userId } = useAuth();
  const authScopeKey = isLoggedIn ? `user:${userId ?? "unknown"}` : "anonymous";

  return (
    <AuthScopedQueryClientProvider key={authScopeKey}>
      <OrganizationProvider>
        <ScopeKeyedQueryClientProvider>{children}</ScopeKeyedQueryClientProvider>
      </OrganizationProvider>
    </AuthScopedQueryClientProvider>
  );
}
