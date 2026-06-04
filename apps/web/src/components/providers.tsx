/**
 * Root provider composition for the web SPA.
 *
 * Wraps the app in auth-scoped → org-scoped QueryClients so that
 * switching users or orgs yields a fresh React Query cache instead of
 * leaking stale data.
 *
 * Third-party library providers (React Query, Radix Tooltip) belong here.
 * Ordinary app state still lives in Zustand stores — see `src/stores/`.
 *
 * Narrow exception: cross-domain "lifted controller" providers like
 * `ProfileQuickAddProvider` also mount here. It owns UI (the profile
 * quick-add modal) that must be reachable from multiple domains without any
 * one of them importing another (which `local/no-cross-domain-imports`
 * forbids), and it must sit inside the request-scoped `QueryClient` because
 * it runs a `useQuery`. Lifting it to this top-level composition is the only
 * place that satisfies both constraints — so it lives here rather than in a
 * store. Do not treat this as license to move general app state out of
 * Zustand.
 *
 * Reference: https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@vellumai/design-library";
import { useState, type ReactNode } from "react";

import { ProfileQuickAddProvider } from "@/components/profile-quick-add-provider";
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
      <ProfileQuickAddProvider>{children}</ProfileQuickAddProvider>
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
