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
import { Toaster } from "@vellumai/design-library/components/toast";
import { useState, type ReactNode } from "react";

import { ProfileQuickAddProvider } from "@/components/profile-quick-add-provider";
import { useAuthStore, useIsAuthenticated } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { queryRetryDelay, shouldRetryQuery } from "@/utils/query-retry";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        // Never retry 429/4xx — retrying a rate-limited request turns a
        // transient burst into a self-sustaining storm against the daemon's
        // request limiter. Per-query `retry` options still override this.
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
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
      {/* Single app-wide toast outlet. Sonner only renders toasts when a
          <Toaster /> is mounted in the tree; without this every `toast.*`
          call (profile/provider create confirmations, "Assistant retired",
          email/save success, etc.) silently no-ops. Kept outside the
          auth/org scope-keyed providers so it survives user/org switches. */}
      <Toaster />
    </TooltipProvider>
  );
}
