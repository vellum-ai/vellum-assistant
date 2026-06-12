import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import {
  AccountForm,
  AccountHeading,
  AccountInput,
} from "@/components/account/account-form";
import { AccountShell } from "@/components/account/account-shell";
import {
  getProviderSignup,
  isConflict,
  submitProviderSignup,
} from "@/lib/auth/allauth-client";
import {
  resolvePostAuthDestination,
  resolvePostLoginDestination,
} from "@/domains/account/login-flow";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

/**
 * Provider signup completion page. Shown when allauth's provider flow needs
 * additional information (email and/or username) from the user before
 * creating the account.
 */
export function ProviderSignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const refreshSession = useAuthStore.use.refreshSession();
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
      try {
        const result = await getProviderSignup();
        if (!result.ok) {
          navigate(routes.account.login, { replace: true });
          return;
        }

        setEmail(result.data.user.email ?? "");
        setUsername(result.data.user.username ?? "");
        setIsLoadingContext(false);
      } catch {
        navigate(routes.account.login, { replace: true });
      }
    })();
  }, [navigate]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await submitProviderSignup({ email, username });

      if (!result.ok) {
        if (isConflict(result)) {
          await refreshSession();
          const conflict = resolvePostLoginDestination(returnTo, routes.account.root);
          if (conflict.requiresFullPageNavigation) {
            window.location.href = conflict.destination;
          } else {
            navigate(conflict.destination);
          }
          return;
        }

        setError(
          result.errors[0]?.message ?? "Failed to complete signup.",
        );
        return;
      }

      await refreshSession();
      const post = resolvePostAuthDestination({
        returnTo,
        fallback: routes.account.root,
        authIntent: "signup",
      });
      if (post.requiresFullPageNavigation) {
        window.location.href = post.destination;
      } else {
        navigate(post.destination);
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
            className="text-sm text-[var(--content-secondary)] hover:text-[var(--content-default)]"
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
