import { Link, useNavigate } from "react-router";

import { AccountHeading } from "@/components/account/account-form.js";
import { AccountShell } from "@/components/account/account-shell.js";
import { PROVIDER_CALLBACK_URL, PROVIDER_ID } from "@/lib/account/login-flow.js";
import { startAuthFlow } from "@/runtime/native-auth.js";
import { useAuth } from "@/lib/auth/auth-provider.js";
import { routes } from "@/utils/routes.js";

/**
 * Account landing page. Shows a sign-in CTA when unauthenticated,
 * or a "Go to your assistant" link + sign-out button when logged in.
 */
export function AccountPage() {
  const navigate = useNavigate();
  const { isLoggedIn, isLoading, username, logout } = useAuth();

  if (isLoading) {
    return (
      <AccountShell>
        <AccountHeading title="Loading..." />
      </AccountShell>
    );
  }

  if (!isLoggedIn) {
    return (
      <AccountShell>
        <AccountHeading
          title="Welcome to Vellum"
          subtitle="Sign in to get started."
        />
        <div className="flex flex-col items-center gap-4">
          <button
            type="button"
            onClick={() => void startAuthFlow(PROVIDER_ID, PROVIDER_CALLBACK_URL)}
            className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--primary-hover)]"
          >
            Sign in
          </button>
        </div>
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <AccountHeading
        title={`Welcome${username ? `, ${username}` : ""}!`}
        subtitle="You are signed in."
      />
      <div className="flex flex-col items-center gap-4">
        <Link
          to={routes.assistant}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-sm font-medium text-white no-underline transition-colors hover:bg-[var(--primary-hover)]"
        >
          Go to your assistant
        </Link>
        <button
          type="button"
          onClick={async () => {
            await logout();
            navigate(routes.account.login);
          }}
          className="cursor-pointer bg-transparent text-sm font-normal text-stone-400 transition-colors hover:text-stone-300"
        >
          Sign out
        </button>
      </div>
    </AccountShell>
  );
}
