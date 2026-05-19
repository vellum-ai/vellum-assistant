/**
 * Organization context provider.
 *
 * Fetches the list of organizations the authenticated user belongs to,
 * resolves the active one (from sessionStorage, then falls back to the
 * first org), and keeps the module-level request state in sync so API
 * interceptors can attach the `Vellum-Organization-Id` header.
 */
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { organizationsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import type { OrganizationRead } from "@/generated/api/types.gen.js";
import { useAuth } from "@/lib/auth/auth-provider.js";

import {
  getActiveOrganizationIdForRequests,
  getStoredOrganizationId,
  resolveActiveOrganizationId,
  setActiveOrganizationIdForRequests,
  subscribeToActiveOrganizationIdForRequests,
} from "@/domains/organization/organization-state.js";

type OrganizationStatus = "idle" | "loading" | "ready" | "error";

interface DeriveOrganizationStatusParams {
  isOrganizationQueryEnabled: boolean;
  isQueryError: boolean;
  isQueryPending: boolean;
  currentOrganizationId: string | null;
  activeRequestOrganizationId: string | null;
}

export function deriveOrganizationStatus({
  isOrganizationQueryEnabled,
  isQueryError,
  isQueryPending,
  currentOrganizationId,
  activeRequestOrganizationId,
}: DeriveOrganizationStatusParams): OrganizationStatus {
  if (!isOrganizationQueryEnabled) return "idle";
  if (isQueryPending && !currentOrganizationId) return "loading";
  if (isQueryError) return "error";
  if (!currentOrganizationId) return "error";
  if (activeRequestOrganizationId !== currentOrganizationId) return "loading";
  return "ready";
}

interface ShouldClearOrganizationRequestStateParams {
  isAuthLoading: boolean;
  isLoggedIn: boolean;
  isQueryError: boolean;
}

export function shouldClearOrganizationRequestState({
  isAuthLoading,
  isLoggedIn,
  isQueryError,
}: ShouldClearOrganizationRequestStateParams): boolean {
  if (isAuthLoading) return false;
  return !isLoggedIn || isQueryError;
}

interface OrganizationContextType {
  organizations: OrganizationRead[];
  currentOrganizationId: string | null;
  status: OrganizationStatus;
  error: string | null;
  setCurrentOrganizationId: (organizationId: string) => void;
  refreshOrganizations: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextType | null>(null);

interface OrganizationProviderProps {
  children: ReactNode;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Failed to load organizations.";
}

export function OrganizationProvider({ children }: OrganizationProviderProps) {
  const { isLoggedIn, isLoading: isAuthLoading } = useAuth();
  const isOrganizationQueryEnabled = isLoggedIn && !isAuthLoading;
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<
    string | null
  >(null);
  const activeRequestOrganizationId = useSyncExternalStore(
    subscribeToActiveOrganizationIdForRequests,
    getActiveOrganizationIdForRequests,
    () => null,
  );

  const organizationsQuery = useQuery({
    ...organizationsListOptions(),
    enabled: isOrganizationQueryEnabled,
    retry: false,
  });

  const organizations = useMemo(
    () =>
      isOrganizationQueryEnabled
        ? (organizationsQuery.data?.results ?? [])
        : [],
    [isOrganizationQueryEnabled, organizationsQuery.data?.results],
  );

  const setCurrentOrganizationId = useCallback(
    (organizationId: string) => {
      if (
        !organizations.some((org) => org.id === organizationId)
      ) {
        return;
      }

      setSelectedOrganizationId(organizationId);
      setActiveOrganizationIdForRequests(organizationId);
    },
    [organizations],
  );

  const { refetch: refetchOrganizations } = organizationsQuery;
  const refreshOrganizations = useCallback(async () => {
    await refetchOrganizations();
  }, [refetchOrganizations]);

  const currentOrganizationId = useMemo(() => {
    const candidateOrganizationId =
      selectedOrganizationId ??
      getStoredOrganizationId() ??
      getActiveOrganizationIdForRequests();
    return resolveActiveOrganizationId(organizations, candidateOrganizationId);
  }, [organizations, selectedOrganizationId]);

  const status: OrganizationStatus = useMemo(() => {
    return deriveOrganizationStatus({
      isOrganizationQueryEnabled,
      isQueryError: organizationsQuery.isError,
      isQueryPending: organizationsQuery.isPending,
      currentOrganizationId,
      activeRequestOrganizationId,
    });
  }, [
    isOrganizationQueryEnabled,
    organizationsQuery.isError,
    organizationsQuery.isPending,
    currentOrganizationId,
    activeRequestOrganizationId,
  ]);

  const error: string | null = useMemo(() => {
    if (!isOrganizationQueryEnabled || organizationsQuery.isPending) {
      return null;
    }
    if (organizationsQuery.isError) {
      return getErrorMessage(organizationsQuery.error);
    }
    if (!currentOrganizationId) {
      return "No organization available for this user.";
    }
    return null;
  }, [
    isOrganizationQueryEnabled,
    organizationsQuery.error,
    organizationsQuery.isError,
    organizationsQuery.isPending,
    currentOrganizationId,
  ]);

  useEffect(() => {
    if (
      shouldClearOrganizationRequestState({
        isAuthLoading,
        isLoggedIn,
        isQueryError: organizationsQuery.isError,
      })
    ) {
      setActiveOrganizationIdForRequests(null);
      return;
    }

    if (!isOrganizationQueryEnabled) return;

    if (!currentOrganizationId) {
      if (!organizationsQuery.isPending) {
        setActiveOrganizationIdForRequests(null);
      }
      return;
    }

    if (activeRequestOrganizationId !== currentOrganizationId) {
      setActiveOrganizationIdForRequests(currentOrganizationId);
    }
  }, [
    isAuthLoading,
    isLoggedIn,
    isOrganizationQueryEnabled,
    organizationsQuery.isError,
    organizationsQuery.isPending,
    currentOrganizationId,
    activeRequestOrganizationId,
  ]);

  const value = useMemo(
    () => ({
      organizations,
      currentOrganizationId,
      status,
      error,
      setCurrentOrganizationId,
      refreshOrganizations,
    }),
    [
      organizations,
      currentOrganizationId,
      status,
      error,
      setCurrentOrganizationId,
      refreshOrganizations,
    ],
  );

  return (
    <OrganizationContext value={value}>
      {children}
    </OrganizationContext>
  );
}

export function useOrganization(): OrganizationContextType {
  const context = useContext(OrganizationContext);
  if (!context) {
    throw new Error(
      "useOrganization must be used within an OrganizationProvider",
    );
  }
  return context;
}
