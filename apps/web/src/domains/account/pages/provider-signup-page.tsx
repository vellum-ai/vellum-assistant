import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import {
  AccountForm,
  AccountHeading,
  AccountInput,
} from "@/components/account/account-form.js";
import { AccountShell } from "@/components/account/account-shell.js";
import {
  getProviderSignup,
  isConflict,
  submitProviderSignup,
} from "@/lib/auth/allauth-client.js";
import { sanitizeReturnTo } from "@/lib/account/return-to.js";
import { useAuth } from "@/lib/auth/auth-provider.js";
import { routes } from "@/utils/routes.js";

function shouldUseFullPageNavigation(destination: string): boolean {
  return (
    destination.startsWith("http") ||
    destination.startsWith("/accounts/") ||
    destination.startsWith("/v1/") ||
    destination.startsWith("/_allauth/")
  );
}

/**
 * Provider signup completion page. Shown when allauth's provider flow needs
 * additional information (email and/or username) from the user before
 * creating the account.
 */
export function ProviderSignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refreshSession } = useAuth();
  const returnTo = searchParams.get("returnTo");

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingContext, setIsLoadingContext] = useState(true);
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;

    (async () => {
      const result = await getProviderSignup();
      if (!result.ok) {
        navigate(routes.account.login, { replace: true });
        return;
      }

      setEmail(result.data.user.email ?? "");
      setUsername(result.data.user.username ?? "");
      setIsLoadingContext(false);
    })();
  }, [navigate]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await submitProviderSignup({ email, username });

      if (!result.ok) {
        if (isConflict(result)) {
          await refreshSession();
          const conflictDestination = sanitizeReturnTo(returnTo, routes.account.root);
          if (shouldUseFullPageNavigation(conflictDestination)) {
            window.location.href = conflictDestination;
          } else {
            navigate(conflictDestination);
          }
          return;
        }

        setError(
          result.errors[0]?.message ?? "Failed to complete signup.",
        );
        return;
      }

      await refreshSession();
      const destination = sanitizeReturnTo(returnTo, routes.account.root);
      if (shouldUseFullPageNavigation(destination)) {
        window.location.href = destination;
      } else {
        navigate(destination);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoadingContext) {
    return (
      <AccountShell>
        <AccountHeading
          title="Completing signup..."
          subtitle="Please wait while we load your information."
        />
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <AccountHeading
        title="Complete your account"
        subtitle="We need a few more details to finish setting up your account."
      />

      <AccountForm
        onSubmit={onSubmit}
        error={error}
        submitLabel="Complete signup"
        submittingLabel="Completing..."
        isSubmitting={isSubmitting}
        footer={
          <Link
            to={routes.account.login}
            className="text-sm text-stone-400 hover:text-stone-300"
          >
            &larr; Back to sign in
          </Link>
        }
      >
        <AccountInput
          id="email"
          type="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <AccountInput
          id="username"
          type="text"
          autoComplete="username"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </AccountForm>
    </AccountShell>
  );
}
