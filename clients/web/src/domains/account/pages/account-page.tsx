import { useState } from "react";
import { Link } from "react-router";

import { useTranslation } from "@/i18n";
import { AccountHeading } from "@/components/account/account-form";
import { AccountShell } from "@/components/account/account-shell";
import {
  PROVIDER_CALLBACK_URL,
  PROVIDER_ID,
} from "@/domains/account/login-flow";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { startAuthFlow } from "@/runtime/native-auth";
import {
  useAuthStore,
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store";
import { routes } from "@/utils/routes";

/**
 * Account landing page. Shows a sign-in CTA when unauthenticated,
 * or a "Go to your assistant" link + sign-out button when logged in.
 */
export function AccountPage() {
  const { t } = useTranslation("account");
  const isAuthenticated = useIsAuthenticated();
  const isSessionInitializing = useIsSessionInitializing();
  const user = useAuthStore.use.user();
  const logout = useAuthStore.use.logout();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const handleSignIn = async () => {
    setErrorMessage(null);
    setSigningIn(true);
    try {
      await startAuthFlow(PROVIDER_ID, PROVIDER_CALLBACK_URL);
    } catch (err) {
      console.error("[account] auth flow failed:", err);
      setErrorMessage(t("authErrors.genericFailure"));
      setSigningIn(false);
    }
  };

  if (isSessionInitializing) {
    return (
      <AccountShell>
        <AccountHeading title={t("accountPage.loading")} />
      </AccountShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <AccountShell>
        <AccountHeading
          title={t("accountPage.welcomeTitle")}
          subtitle={t("accountPage.welcomeSubtitle")}
        />
        {errorMessage && (
          <p className="text-center text-sm text-[var(--system-negative-strong)]">
            {errorMessage}
          </p>
        )}
        <div className="flex flex-col items-center gap-4">
          <button
            type="button"
            onClick={() => void handleSignIn()}
            disabled={signingIn}
            className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
          >
            {t("accountPage.signIn")}
          </button>
        </div>
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <AccountHeading
        title={
          user?.username
            ? t("accountPage.signedInTitleNamed", { name: user.username })
            : t("accountPage.signedInTitle")
        }
        subtitle={t("accountPage.signedInSubtitle")}
      />
      <div className="flex flex-col items-center gap-4">
        <Link
          to={routes.assistant}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-[var(--content-inset)] no-underline transition-colors hover:bg-[var(--primary-hover)]"
        >
          {t("accountPage.goToAssistant")}
        </Link>
        <button
          type="button"
          onClick={async () => {
            await logout();
            hardNavigate(routes.account.login);
          }}
          className="cursor-pointer bg-transparent text-sm font-normal text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
        >
          {t("accountPage.signOut")}
        </button>
      </div>
    </AccountShell>
  );
}
