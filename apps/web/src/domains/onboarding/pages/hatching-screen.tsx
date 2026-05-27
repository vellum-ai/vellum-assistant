import * as Sentry from "@sentry/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { ProgressBar } from "@vellum/design-library/components/progress-bar";
import { getAssistant, hatchAssistant } from "@/assistant/api";
import {
  isPlatformHostedDisabled,
  PLATFORM_HOSTED_DISABLED_MESSAGE,
  resolveAssistantLifecycleState,
  shouldRecoverFromHatchFailure,
} from "@/assistant/lifecycle";
import { fetchCharacterTraits, saveCharacterTraits } from "@/assistant/avatar-api";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@/utils/avatar-random";
import { composeSvg } from "@/utils/avatar-svg-compositor";
import type { CharacterTraits } from "@/types/avatar";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { extractErrorMessage } from "@/lib/api-errors";
import {
  readAiDataConsent,
  readOnboardingCompleted,
  readSelectedVersion,
  readTosAccepted,
  useOnboardingCompleted,
  writeSelectedVersion,
} from "@/domains/onboarding/prefs";
import {
  clearPrivacyConsent,
  hasRecentPrivacyConsent,
  markPrivacyConsent,
} from "@/domains/onboarding/signals";
import { isNativePlatform } from "@/runtime/native-auth";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

const POLL_INTERVAL_MS = 3000;
const COMPLETION_NAVIGATE_DELAY_MS = 800;
const MAX_HATCH_WAIT_MS = 300_000;

type HatchPhase = "initializing" | "provisioning" | "connecting" | "ready";

const PHASE_TARGET: Record<HatchPhase, number> = {
  initializing: 0,
  provisioning: 0.33,
  connecting: 0.66,
  ready: 1.0,
};

const SEGMENT_DURATION_MS = 1500;

const PHASE_LABEL: Record<HatchPhase, string> = {
  initializing: "Getting things ready…",
  provisioning: "Setting up your assistant…",
  connecting: "Connecting to your assistant…",
  ready: "Ready",
};

export function interpolateSegmentProgress(
  segmentStart: number,
  target: number,
  elapsedMs: number,
): number {
  if (segmentStart >= target) return target;
  const t = Math.min(1.0, elapsedMs / SEGMENT_DURATION_MS);
  const eased = 1.0 - Math.pow(1.0 - t, 3.0);
  return segmentStart + (target - segmentStart) * eased;
}

export type HatchGateDecision =
  | { kind: "proceed" }
  | { kind: "wait" }
  | { kind: "redirect"; to: string };

export function decideHatchGate(input: {
  isAuthLoading: boolean;
  isLoggedIn: boolean;
  onboardingCompleted: boolean;
  tosAccepted: boolean;
  aiDataConsentAccepted: boolean;
  cameFromPrivacyScreen: boolean;
}): HatchGateDecision {
  if (input.isAuthLoading) return { kind: "wait" };
  if (!input.isLoggedIn) return { kind: "redirect", to: routes.account.login };
  if (input.onboardingCompleted) return { kind: "redirect", to: routes.assistant };
  const persistedConsent = input.tosAccepted && input.aiDataConsentAccepted;
  if (!input.cameFromPrivacyScreen && !persistedConsent) {
    return { kind: "redirect", to: routes.onboarding.privacy };
  }
  return { kind: "proceed" };
}

export function HatchingScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isReplay = searchParams.get("replay") === "1";
  const userId = useAuthStore.use.user()?.id ?? null;
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const isAuthLoading = useAuthStore.use.isLoading();
  const [, setOnboardingCompleted] = useOnboardingCompleted();
  const [hatchTraits] = useState<CharacterTraits>(() =>
    randomCharacterTraits(BUNDLED_COMPONENTS),
  );
  const avatarSvgDataUrl = useMemo(() => {
    const svg = composeSvg(
      BUNDLED_COMPONENTS,
      hatchTraits.bodyShape,
      hatchTraits.eyeStyle,
      hatchTraits.color,
      320,
    );
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [hatchTraits]);
  const [phase, setPhase] = useState<HatchPhase>("initializing");
  const [error, setError] = useState<string | null>(null);
  const [platformHostedDisabled, setPlatformHostedDisabled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [displayProgress, setDisplayProgress] = useState<number>(0);
  const [animationEpoch, setAnimationEpoch] = useState(0);

  const phaseRef = useRef<HatchPhase>(phase);
  const segmentStartRef = useRef(0);
  const segmentStartTimeRef = useRef(0);
  const displayProgressRef = useRef(0);

  const transitionPhase = useCallback((next: HatchPhase) => {
    segmentStartRef.current = displayProgressRef.current;
    segmentStartTimeRef.current = Date.now();
    phaseRef.current = next;
    setPhase(next);
    setAnimationEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    const cameFromPrivacyScreen = hasRecentPrivacyConsent(userId);
    const decision = decideHatchGate({
      isAuthLoading,
      isLoggedIn,
      onboardingCompleted: readOnboardingCompleted(),
      tosAccepted: readTosAccepted(),
      aiDataConsentAccepted: readAiDataConsent(),
      cameFromPrivacyScreen,
    });
    if (decision.kind === "redirect") {
      void navigate(decision.to, { replace: true });
      return;
    }
    if (decision.kind === "wait") return;

    setPlatformHostedDisabled(false);

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let navigateTimer: ReturnType<typeof setTimeout> | null = null;
    const pollStartMs = Date.now();

    const pinnedVersion = readSelectedVersion();

    const startHatch = async () => {
      transitionPhase("provisioning");
      if (isReplay) {
        scheduleNextPoll(0);
        return;
      }
      try {
        const result = await hatchAssistant(
          pinnedVersion ? { version: pinnedVersion } : undefined,
        );
        if (cancelled) return;
        if (!result.ok) {
          Sentry.captureMessage("Onboarding hatch request failed", {
            level: "warning",
            extra: { status: result.status, error: result.error },
          });
          if (isPlatformHostedDisabled(result.status, result.error)) {
            setError(PLATFORM_HOSTED_DISABLED_MESSAGE);
            setPlatformHostedDisabled(true);
            return;
          }
          if (shouldRecoverFromHatchFailure(result.status)) {
            // Recoverable — fall through to polling
          } else {
            setError(
              extractErrorMessage(
                result.error,
                undefined,
                "Failed to start your assistant. Please try again.",
              ),
            );
            return;
          }
        }
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "onboarding_hatch_assistant" },
        });
        if (cancelled) return;
      }

      scheduleNextPoll(0);
    };

    const scheduleNextPoll = (delay: number) => {
      if (cancelled) return;
      pollTimer = setTimeout(runPoll, delay);
    };

    const runPoll = async () => {
      if (cancelled) return;
      if (Date.now() - pollStartMs >= MAX_HATCH_WAIT_MS) {
        Sentry.captureMessage("Onboarding hatch wait exceeded timeout", {
          level: "warning",
          extra: { maxWaitMs: MAX_HATCH_WAIT_MS },
        });
        setError(
          "Your assistant is taking longer than expected. Please try again.",
        );
        return;
      }
      try {
        const result = await getAssistant();
        if (cancelled) return;
        const next = resolveAssistantLifecycleState(result);
        if (next.kind === "active") {
          try {
            writeSelectedVersion("");
          } catch (err) {
            Sentry.captureException(err, {
              tags: { context: "onboarding_mark_completed" },
            });
          }
          markPrivacyConsent(userId);

          if (result.ok) {
            const assistantId = result.data.id;
            fetchCharacterTraits(assistantId).then((existing) => {
              if (existing) return;
              return saveCharacterTraits(assistantId, hatchTraits);
            }).catch((err) => {
              Sentry.captureException(err, {
                tags: { context: "onboarding_avatar_sync" },
              });
            });
          }

          setDisplayProgress(1);
          displayProgressRef.current = 1;
          segmentStartRef.current = 1;
          setPhase("ready");
          phaseRef.current = "ready";
          navigateTimer = setTimeout(() => {
            if (cancelled) return;
            if (isNativePlatform()) {
              try {
                setOnboardingCompleted(true);
              } catch (err) {
                Sentry.captureException(err, {
                  tags: { context: "hatching_mark_onboarding_completed_native" },
                });
              }
              clearPrivacyConsent();
              void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
              return;
            }
            void navigate(routes.onboarding.prechat, { replace: true });
          }, COMPLETION_NAVIGATE_DELAY_MS);
          return;
        }
        if (next.kind === "error") {
          setError(next.message);
          return;
        }
        if (next.kind !== "auto_hatch" && phaseRef.current === "provisioning") {
          transitionPhase("connecting");
        }
        scheduleNextPoll(POLL_INTERVAL_MS);
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "onboarding_poll_assistant" },
        });
        if (cancelled) return;
        scheduleNextPoll(POLL_INTERVAL_MS);
      }
    };

    void startHatch();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (navigateTimer) clearTimeout(navigateTimer);
    };
  }, [
    attempt,
    hatchTraits,
    isAuthLoading,
    isLoggedIn,
    isReplay,
    navigate,
    setOnboardingCompleted,
    transitionPhase,
    userId,
  ]);

  useEffect(() => {
    if (segmentStartTimeRef.current === 0) {
      segmentStartTimeRef.current = Date.now();
    }
    let rafId: number;
    const tick = () => {
      const elapsed = Date.now() - segmentStartTimeRef.current;
      const target = PHASE_TARGET[phaseRef.current];
      const value = interpolateSegmentProgress(
        segmentStartRef.current,
        target,
        elapsed,
      );
      displayProgressRef.current = value;
      setDisplayProgress(value);
      if (target - value > 1e-6) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [animationEpoch]);

  if (error) {
    return (
      <OnboardingLayout>
        <div
          role="alert"
          className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 pb-40 text-center text-[var(--content-default)]"
        >
          {/* typography: off-scale — hero onboarding h1 (30px) larger than text-title-large (24px) to match macOS visual weight */}
          <h1 className="text-3xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="mt-4 text-body-medium-lighter text-[var(--content-tertiary)]">
            {error}
          </p>
          {platformHostedDisabled && (
            <div className="mt-6 flex w-full max-w-sm flex-col items-center gap-3">
              <p className="text-body-medium-default text-[var(--content-default)]">
                Get started today with a local assistant
              </p>
              <Button
                asChild
                variant="primary"
                size="regular"
                fullWidth
                className="h-11 text-base"
              >
                <a href={`${window.location.origin}/download`}>
                  Download the macOS app
                </a>
              </Button>
            </div>
          )}
          <img
            src={avatarSvgDataUrl}
            alt=""
            width={160}
            height={160}
            className="my-16 onboarding-avatar-failed"
          />
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Button
              variant="primary"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={() => {
                segmentStartRef.current = 0;
                segmentStartTimeRef.current = Date.now();
                phaseRef.current = "initializing";
                displayProgressRef.current = 0;
                setPhase("initializing");
                setDisplayProgress(0);
                setAnimationEpoch((n) => n + 1);
                setError(null);
                setPlatformHostedDisabled(false);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
            <Button
              variant="outlined"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={() =>
                void navigate(
                  isReplay
                    ? `${routes.onboarding.privacy}?replay=1`
                    : routes.onboarding.privacy,
                  { replace: true },
                )
              }
            >
              Back
            </Button>
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout>
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 pb-40 text-center text-[var(--content-default)]">
        {/* typography: off-scale — hero onboarding h1 (30px) larger than text-title-large (24px) to match macOS visual weight */}
        <h1 className="text-3xl font-semibold tracking-tight">
          {phase === "ready" ? "Your assistant is ready!" : "Waking up…"}
        </h1>
        {phase !== "ready" && (
          <p className="mt-4 text-body-medium-lighter text-[var(--content-tertiary)]">
            Hang tight — your assistant will have a few questions for you once
            it&apos;s up.
          </p>
        )}
        <img
          src={avatarSvgDataUrl}
          alt=""
          width={160}
          height={160}
          className={`my-16 ${phase === "ready" ? "onboarding-avatar-awake" : "onboarding-avatar-pulse"}`}
        />
        <ProgressBar
          value={displayProgress}
          height={6}
          className="w-full max-w-sm"
          aria-label="Assistant startup progress"
        />
        <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
          {PHASE_LABEL[phase]}
        </p>
      </div>
    </OnboardingLayout>
  );
}
