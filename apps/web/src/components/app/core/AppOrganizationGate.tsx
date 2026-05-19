
import { Loader2 } from "lucide-react";
import { useNavigate, useLocation, useSearchParams } from "react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { NativeSplash } from "@/components/shared/NativeSplash.js";
import { buildLoginRedirectUrl } from "@/lib/account/login-flow.js";
import { useAuth } from "@/lib/auth.js";
import { useIsNativePlatform } from "@/lib/native-auth.js";
import { useOrganization } from "@/lib/organization/organization-provider.js";
import { routes } from "@/lib/routes.js";

interface AppOrganizationGateProps {
  children: ReactNode;
}

function LoadingState({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--content-disabled)]" />
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">{message}</p>
      </div>
    </div>
  );
}

export function AppOrganizationGate({ children }: AppOrganizationGateProps) {
  const {
    isLoading: isAuthLoading,
    isLoggedIn,
    refreshSession,
  } = useAuth();
  const {
    currentOrganizationId,
    error,
    refreshOrganizations,
    status,
  } = useOrganization();
  const navigate = useNavigate();
  const { pathname: pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const [isRetrying, setIsRetrying] = useState(false);
  const isNative = useIsNativePlatform();

  const retry = useCallback(async () => {
    if (isRetrying) {
      return;
    }

    setIsRetrying(true);
    try {
      await refreshSession();
      await refreshOrganizations();
    } finally {
      setIsRetrying(false);
    }
  }, [isRetrying, refreshOrganizations, refreshSession]);

  useEffect(() => {
    if (isAuthLoading || isLoggedIn) return;
    // Omit returnTo for /logout to avoid a login → /logout → login cycle.
    const target = pathname === routes.logout
      ? routes.account.login
      : buildLoginRedirectUrl(pathname, searchParams);
    navigate(target, { replace: true });
  }, [isAuthLoading, isLoggedIn, pathname, searchParams, navigate]);

  if (isAuthLoading) {
    if (isNative) return <NativeSplash />;
    return <LoadingState message="Checking your session..." />;
  }

  if (!isLoggedIn) {
    if (isNative) return <NativeSplash />;
    return null;
  }

  if (status === "ready" && currentOrganizationId) {
    return <>{children}</>;
  }

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-md rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950">
          <h2 className="text-title-medium text-red-700 dark:text-red-300">
            Unable to load organization
          </h2>
          <p className="mt-2 text-body-medium-lighter text-red-700/90 dark:text-red-300/90">
            {error ?? "We could not determine your active organization."}
          </p>
          <button
            type="button"
            onClick={() => void retry()}
            disabled={isRetrying}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-body-medium-default text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRetrying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (isNative) return <NativeSplash />;
  return <LoadingState message="Loading your organization..." />;
}
