
import * as Sentry from "@sentry/react";
import { EyeOff } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { useEffect, useId, type ReactNode } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Checkbox } from "@vellum/design-library/components/checkbox";
import { Toggle } from "@vellum/design-library/components/toggle";
import { OnboardingLayout } from "@/components/app/onboarding/OnboardingLayout.js";
import { useAuth } from "@/lib/auth.js";
import {
  readOnboardingCompleted,
  useAiDataConsent,
  useShareAnalytics,
  useShareDiagnostics,
  useTosAccepted,
} from "@/lib/onboarding/prefs.js";
import { markPrivacyConsent } from "@/lib/onboarding/signals.js";
import { legalUrl, routes } from "@/lib/routes.js";

/**
 * Row used for each Share preference toggle. Local to this file so the
 * shared `Card` primitive stays untouched.
 *
 * Layout: a horizontal flex row with the toggle on the left and the stacked
 * label / helper text on the right. The parent `Card` is responsible for
 * wrapping multiple rows together.
 */
function SettingRow({
  label,
  helperText,
  checked,
  onChange,
}: {
  label: string;
  helperText: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const toggleId = useId();
  return (
    <div className="flex items-start gap-4">
      <Toggle
        checked={checked}
        onChange={onChange}
        id={toggleId}
        aria-label={label}
      />
      <label htmlFor={toggleId} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-body-medium-default text-[var(--content-default)]">
          {label}
        </span>
        <span className="mt-1 block text-body-small-default text-[var(--content-tertiary)]">
          {helperText}
        </span>
      </label>
    </div>
  );
}

export function PrivacyScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // `?replay=1` is set by the Vellum-only debug "Replay onboarding" action
  // (see DebugControlsPanel). Forwarded to /onboarding/hatching so it can
  // skip the actual hatch call and avoid spawning a duplicate assistant.
  const isReplay = searchParams.get("replay") === "1";
  const { userId } = useAuth();
  const [shareAnalytics, setShareAnalytics] = useShareAnalytics();
  const [shareDiagnostics, setShareDiagnostics] = useShareDiagnostics();
  const [tosAccepted, setTosAccepted] = useTosAccepted();
  const [aiDataConsent, setAiDataConsent] = useAiDataConsent();

  // If the user already completed onboarding (i.e. hatched successfully),
  // don't re-show this screen — bounce them to the assistant. The
  // `onboarding.completed` flag is set on hatch success (in HatchingScreen),
  // not here, so a user who hit Back from an errored hatch can re-enter the
  // privacy screen without being bounced.
  useEffect(() => {
    if (readOnboardingCompleted()) {
      navigate(routes.assistant, { replace: true });
    }
  }, [navigate]);

  function onStart() {
    // Guard the localStorage writes so a disabled / quota-exceeded storage
    // can't strand the user on this screen. Losing the share-pref persist
    // just means the settings page reflects defaults on next visit — an
    // acceptable degradation compared to blocking the hatch flow entirely.
    // `onboarding.completed` is deliberately NOT set here — HatchingScreen
    // writes it on successful hatch, so a failed hatch + Back lands the
    // user back on this screen rather than being bounced to `/assistant`.
    try {
      setShareAnalytics(shareAnalytics);
      setShareDiagnostics(shareDiagnostics);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "onboarding_persist_share_prefs" },
      });
    }
    // In-memory fallback consent signal — the hatching screen's gate
    // accepts this as equivalent to `readTosAccepted()=true` on storage-
    // disabled browsers where the persist silently no-ops. Module-scoped
    // rather than URL-scoped so a shared / bookmarked / manually-typed
    // `/onboarding/hatching` link can't bypass the TOS checkbox.
    markPrivacyConsent(userId);
    navigate(
      isReplay
        ? (`${routes.onboarding.hatching}?replay=1`)
        : routes.onboarding.hatching,
    );
  }

  const tosLabel: ReactNode = (
    <span className="text-body-medium-lighter text-[var(--content-default)]">
      I agree to the{" "}
      <a
        href={legalUrl(routes.docs.legal.termsOfUse)}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        Terms of Service
      </a>{" "}
      and{" "}
      <a
        href={legalUrl(routes.docs.legal.privacyPolicy)}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        Privacy Policy
      </a>
    </span>
  );

  const aiConsentLabel: ReactNode = (
    <span className="text-body-medium-lighter text-[var(--content-default)]">
      I agree to the{" "}
      <a
        href={legalUrl(routes.docs.legal.dataSharing)}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        AI Data Sharing Policy
      </a>
    </span>
  );

  return (
    <OnboardingLayout>
      <div className="mx-auto flex w-full max-w-xl flex-col items-center px-6 py-16 text-[var(--content-default)]">
        {/* typography: off-scale — hero onboarding h1 (30px) intentionally larger than text-title-large (24px) to match macOS onboarding visual weight */}
        { }
        <h1 className="text-3xl font-semibold tracking-tight">
          Before You Start
        </h1>
        <p className="mt-4 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
          Choose your privacy preferences. You can update these anytime in the
          Settings.
        </p>

        <Card padding="md" className="mt-8 w-full">
          <div className="flex flex-col gap-4">
            <SettingRow
              label="Share Analytics"
              helperText="Send anonymous product usage data."
              checked={shareAnalytics}
              onChange={setShareAnalytics}
            />
            <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
            <SettingRow
              label="Share Diagnostics"
              helperText="Send crash reports and performance metrics."
              checked={shareDiagnostics}
              onChange={setShareDiagnostics}
            />
            <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
            <div className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
              <EyeOff className="h-4 w-4 shrink-0" />
              <span>Your conversations and personal data are never included.</span>
            </div>
          </div>
        </Card>

        <div className="mt-6 flex w-full items-start">
          <Checkbox
            checked={aiDataConsent}
            onCheckedChange={(next) => setAiDataConsent(next === true)}
            label={aiConsentLabel}
            aria-label="I agree to the AI Data Sharing Policy"
          />
        </div>

        <div className="mt-4 flex w-full items-start">
          <Checkbox
            checked={tosAccepted}
            onCheckedChange={(next) => setTosAccepted(next === true)}
            label={tosLabel}
            aria-label="I agree to the Terms of Service and Privacy Policy"
          />
        </div>

        <div className="mt-8 flex w-full flex-col gap-2">
          {/*
            Button primitive only exposes `regular` / `compact` sizes, so we
            upsize via className to match the spec's "lg" CTA. The `primary`
            variant resolves to a white-on-dark fill in the app dark theme.
            The outer stack uses the full container width so the buttons
            match the width of the Share preference cards above.
          */}
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!tosAccepted || !aiDataConsent}
            onClick={onStart}
            // typography: off-scale — CTA upsize; Button primitive only exposes regular/compact so text-base forces the spec's 16px "lg" size
             
            className="h-11 text-base"
          >
            Start
          </Button>
          {/*
            Outlined CTA. `Button` already ships a dedicated `outlined`
            variant, so we use it directly (matches the Back button on
            HatchingScreen for visual consistency across the onboarding
            flow).
          */}
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={() => navigate(-1)}
            // typography: off-scale — CTA upsize paired with the Start button above
             
            className="h-11 text-base"
          >
            Back
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
