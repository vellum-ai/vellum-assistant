import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import {
  AccountForm,
  AccountHeading,
  AccountInput,
} from "@/components/account/account-form";
import { AccountShell } from "@/components/account/account-shell";
import { PersonalPageShell } from "@/domains/account/components/personal-page-shell";
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

  // The personal-page step hides email/username and submits the provider-
  // supplied values. If the provider didn't supply them (rare — WorkOS social
  // always returns an email, and allauth suggests a username), fall through to
  // the editable control form so the user can complete signup rather than hit
  // an uncorrectable validation error.
  if (personalPage && email && username) {
    const canSubmit = occupation.trim().length > 0 && !isSubmitting;
    return (
      <PersonalPageShell>
        <form onSubmit={onPersonalPageSubmit} className="cast-about__thread">
          <h2 className="cast-about__heading">
            Almost there,
            <br />
            one more detail
          </h2>

          {error && <p className="cast-about__error">{error}</p>}

          <div className="cast-about__step">
            <span className="cast-about__label">
              What should I call you? <span className="cast-about__req">*</span>
            </span>
            <input
              className="cast-about__input"
              type="text"
              placeholder="First name"
              value={firstName}
              readOnly
              disabled
            />
          </div>

          <div className="cast-about__step">
            <span className="cast-about__label">
              And your last name? <span className="cast-about__req">*</span>
            </span>
            <input
              className="cast-about__input"
              type="text"
              placeholder="Last name"
              value={lastName}
              readOnly
              disabled
            />
          </div>

          <div className="cast-about__step">
            <span className="cast-about__label">
              Your role <span className="cast-about__req">*</span>
            </span>
            <input
              className="cast-about__input"
              type="text"
              autoComplete="organization-title"
              placeholder="e.g. Software Engineer"
              value={occupation}
              onChange={(e) => setOccupation(e.target.value)}
              autoFocus
            />
          </div>

          <div className="cast-about__step">
            <button
              type="submit"
              className="cast-about__continue"
              disabled={!canSubmit}
            >
              {isSubmitting ? "Setting up…" : "Continue →"}
            </button>
          </div>
        </form>
      </PersonalPageShell>
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
