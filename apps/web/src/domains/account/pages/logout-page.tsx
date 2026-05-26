import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

import { AccountHeading } from "@/components/account/account-form.js";
import { AccountShell } from "@/components/account/account-shell.js";
import { sanitizeReturnTo } from "@/domains/account/return-to.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { routes } from "@/utils/routes.js";

export function LogoutPage() {
  const [searchParams] = useSearchParams();
  const logout = useAuthStore.use.logout();
  const logoutInitiated = useRef(false);

  useEffect(() => {
    if (logoutInitiated.current) return;
    logoutInitiated.current = true;

    const returnTo = sanitizeReturnTo(
      searchParams.get("returnTo"),
      routes.account.login,
    );

    // If returnTo is an absolute URL (cross-origin), redirect there directly.
    // Otherwise, redirect to login with returnTo as a param.
    const target =
      returnTo.startsWith("http") || returnTo === routes.account.login
        ? returnTo
        : `${routes.account.login}?returnTo=${encodeURIComponent(returnTo)}`;

    let cancelled = false;
    logout().then(
      () => { if (!cancelled) window.location.href = target; },
      () => { if (!cancelled) window.location.href = target; },
    );
    return () => { cancelled = true; };
  }, [logout, searchParams]);

  return (
    <AccountShell>
      <AccountHeading title="Signing out..." />
    </AccountShell>
  );
}
