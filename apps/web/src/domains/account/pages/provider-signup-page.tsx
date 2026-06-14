import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { Button, Notice } from "@vellumai/design-library";

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
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";

/**
 * Provider signup completion page. Shown when allauth's provider flow needs
 * additional information before creating the account.
 *
 * Default (control / variant-a): collect email + username.
 *
 * When `experiment-activation-flow-2026-06-03` serves `personal-page`: show the
 * OAuth-claim first/last name as read-only and collect an occupation, which is
 * forwarded into the pre-chat onboarding context. The account is still
 * completed via the same `submitProviderSignup` call using the provider-supplied
 * email + username (no username field — matching the standard sign-up, which
 * does not surface one to the user).
 */
export function ProviderSignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const refreshSession = useAuthStore.use.refreshSession();
  const returnTo = searchParams.get("returnTo");

  const activationArm =
    useClientFeatureFlagStore.use.stringFlags().experimentActivationFlow20260603 ??
    "control";
  const personalPage = activationArm === "personal-page";

  // Provider-supplied identity. email + username are submitted to complete the
  // account; firstName/lastName are display-only (read-only) in the
  // personal-page variant. All come from the pending provider-signup context.
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [occupation, setOccupation] = useState("");
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
        setFirstName(result.data.user.first_name ?? "");
        setLastName(result.data.user.last_name ?? "");
        setIsLoadingContext(false);
      } catch {
        navigate(routes.account.login, { replace: true });
      }
    })();
  }, [navigate]);

  const completeSignup = async () => {
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

      setError(result.errors[0]?.message ?? "Failed to complete signup.");
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
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await completeSignup();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const onPersonalPageSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!occupation.trim()) return;
    setError(null);
    setIsSubmitting(true);
    try {
      // NOTE: occupation is collected but not yet persisted. Forwarding it into
      // the onboarding handoff requires a shared cross-domain contract (the
      // `account` domain may not import `onboarding` directly). Deferred.
      await completeSignup();
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

  if (personalPage) {
    const canSubmit = occupation.trim().length > 0 && !isSubmitting;
    return (
      <AccountShell>
        <AccountHeading
          title="Almost there"
          subtitle="One more detail to finish setting up your account."
        />
        <form onSubmit={onPersonalPageSubmit} className="flex flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-col gap-3">
            <AccountInput
              id="firstName"
              type="text"
              placeholder="First name"
              value={firstName}
              readOnly
              disabled
            />
            <AccountInput
              id="lastName"
              type="text"
              placeholder="Last name"
              value={lastName}
              readOnly
              disabled
            />
            <AccountInput
              id="occupation"
              type="text"
              autoComplete="organization-title"
              placeholder="What's your role? (e.g. Software Engineer)"
              value={occupation}
              onChange={(e) => setOccupation(e.target.value)}
              autoFocus
              required
            />
          </div>
          <Button type="submit" variant="primary" fullWidth disabled={!canSubmit}>
            {isSubmitting ? "Completing..." : "Continue"}
          </Button>
        </form>
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
