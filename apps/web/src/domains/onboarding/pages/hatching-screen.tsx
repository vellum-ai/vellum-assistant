import * as Sentry from "@sentry/react";
import { captureError } from "@/lib/sentry/capture-error";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { ProgressBar } from "@vellum/design-library/components/progress-bar";
import { getAssistant } from "@/assistant/api";
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
import { extractErrorMessage } from "@/utils/api-errors";
import { isLocalMode, loadLockfile, setSelectedAssistantId, saveLockfileAssistant, primeLocalGatewayConnection, getLocalGatewayUrl } from "@/lib/local-mode";
import { getOnboardingEntrypoint } from "@/domains/onboarding/gate";
import {
  getLocalHatchPromise,
  getPlatformHatchPromise,
  clearLocalHatch,
  clearPlatformHatch,
  triggerLocalHatch,
  triggerPlatformHatch,
} from "@/domains/onboarding/hatch-trigger";
import { applyPendingProviderKey } from "@/domains/onboarding/provider-key";
import { lifecycleService } from "@/assistant/lifecycle-service";
import {
  readAiDataConsent,
  readOnboardingCompleted,
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
import {
  isAuthenticated,
  isSessionSettled,
  type SessionStatus,
} from "@/stores/session-status";
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
  sessionStatus: SessionStatus;
  isReplay: boolean;
  onboardingCompleted: boolean;
  tosAccepted: boolean;
  aiDataConsentAccepted: boolean;
  cameFromPrivacyScreen: boolean;
}): HatchGateDecision {
  if (!isSessionSettled(input.sessionStatus)) return { kind: "wait" };
  if (!isAuthenticated(input.sessionStatus) && !isLocalMode()) {
    return { kind: "redirect", to: routes.account.login };
  }
  if (input.onboardingCompleted && !input.isReplay) {
    return { kind: "redirect", to: routes.assistant };
  }
  // Consent (incl. local mode): the privacy screen is now shown for every
  // hosting option, so require it for local hatches too. The privacy screen
  // persists tosAccepted/aiDataConsent and marks the in-memory consent signal.
  const persistedConsent = input.tosAccepted && input.aiDataConsentAccepted;
  if (!input.cameFromPrivacyScreen && !persistedConsent) {
    return { kind: "redirect", to: getOnboardingEntrypoint() };
  }
  return { kind: "proceed" };
}

export function HatchingScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isReplay = searchParams.get("replay") === "1";
  const hostingParam = searchParams.get("hosting");
  const useLocalHatch = isLocalMode() && hostingParam !== null && hostingParam !== "vellum-cloud";
  const userId = useAuthStore.use.user()?.id ?? null;
  const sessionStatus = useAuthStore.use.sessionStatus();

  // Refs for values the hatch effect reads but must NOT restart on.
  // The platform-session probe can settle mid-hatch and change userId
  // (from the local placeholder to the real platform user), which would
  // re-trigger the effect, cancel the in-flight readiness poll, and
  // start a duplicate hatch.
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const sessionStatusRef = useRef(sessionStatus);
  sessionStatusRef.current = sessionStatus;
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

  // If the main effect returned early because the session wasn't settled
  // yet ("wait"), re-trigger it once the session settles so the gate
  // can re-evaluate. This is a separate effect so sessionStatus changes
  // during an in-flight hatch don't restart the main effect.
  const [gateWaiting, setGateWaiting] = useState(false);
  useEffect(() => {
    if (gateWaiting && isSessionSettled(sessionStatus)) {
      setGateWaiting(false);
      setAttempt((n) => n + 1);
    }
  }, [gateWaiting, sessionStatus]);

  useEffect(() => {
    const snapshotUserId = userIdRef.current;
    const snapshotSessionStatus = sessionStatusRef.current;
    const cameFromPrivacyScreen = hasRecentPrivacyConsent(snapshotUserId);
    const decision = decideHatchGate({
      sessionStatus: snapshotSessionStatus,
      isReplay,
      onboardingCompleted: readOnboardingCompleted(),
      tosAccepted: readTosAccepted(),
      aiDataConsentAccepted: readAiDataConsent(),
      cameFromPrivacyScreen,
    });
    if (decision.kind === "redirect") {
      void navigate(decision.to, { replace: true });
      return;
    }
    if (decision.kind === "wait") {
      setGateWaiting(true);
      return;
    }

    setPlatformHostedDisabled(false);

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let navigateTimer: ReturnType<typeof setTimeout> | null = null;
    let readyPollTimer: ReturnType<typeof setTimeout> | null = null;
    const pollStartMs = Date.now();

    const handleHatchReady = () => {
      try {
        writeSelectedVersion("");
      } catch (err) {
        captureError(err, { context: "onboarding_mark_completed" });
      }
      markPrivacyConsent(userIdRef.current);
      setDisplayProgress(1);
      displayProgressRef.current = 1;
      segmentStartRef.current = 1;
      setPhase("ready");
      phaseRef.current = "ready";
      navigateTimer = setTimeout(() => {
        if (cancelled) return;
        void (async () => {
          await lifecycleService.checkAssistant();
          if (cancelled) return;
          if (isNativePlatform()) {
            try {
              setOnboardingCompleted(true);
            } catch (err) {
              captureError(err, { context: "hatching_mark_onboarding_completed_native" });
            }
            clearPrivacyConsent();
            // Native flow skips the pre-chat screen, so there's no
            // typed message to drive the auto-greet gate. Mark the
            // lifecycle one-shot so the destination chat mount shows
            // the loading gate until the server greeting arrives.
            lifecycleService.markExpectingFirstMessage();
            void navigate(`${routes.assistant}?onboarding=1`, {
              replace: true,
            });
            return;
          }
          void navigate(
            isReplay
              ? `${routes.onboarding.prechat}?replay=1`
              : routes.onboarding.prechat,
            { replace: true },
          );
        })();
      }, COMPLETION_NAVIGATE_DELAY_MS);
    };

    const startHatch = async () => {
      transitionPhase("provisioning");
      if (isReplay) {
        scheduleNextPoll(0);
        return;
      }

      // The privacy screen fires the hatch before navigating here.
      // If the promise is missing (page refresh, direct URL entry),
      // bounce back to the privacy screen rather than re-triggering.
      if (useLocalHatch) {
        const hatchPromise = getLocalHatchPromise();
        if (!hatchPromise) {
          void navigate(getOnboardingEntrypoint(), { replace: true });
          return;
        }
        try {
          const result = await hatchPromise;
          clearLocalHatch();
          if (cancelled) return;
          if (!result.ok) {
            setError(result.error ?? "Failed to hatch local assistant.");
            return;
          }
          await loadLockfile();
          if (result.assistantId) {
            setSelectedAssistantId(result.assistantId);
          }

          transitionPhase("connecting");
          let gatewayReady = false;
          while (!cancelled && !gatewayReady) {
            const gatewayUrl = getLocalGatewayUrl();
            if (gatewayUrl) {
              try {
                const res = await fetch(`${gatewayUrl}/readyz`);
                if (res.ok) {
                  const body: unknown = await res.json();
                  if (
                    body &&
                    typeof body === "object" &&
                    "status" in body &&
                    body.status === "ok"
                  ) {
                    await primeLocalGatewayConnection();
                    gatewayReady = true;
                    break;
                  }
                }
              } catch {
                // Gateway not ready yet
              }
            }
            if (Date.now() - pollStartMs >= MAX_HATCH_WAIT_MS) {
              setError("Your assistant is taking longer than expected. Please try again.");
              return;
            }
            await new Promise<void>(resolve => {
              readyPollTimer = setTimeout(resolve, POLL_INTERVAL_MS);
            });
            readyPollTimer = null;
          }
          if (cancelled) return;

          if (result.assistantId) {
            try {
              await applyPendingProviderKey(result.assistantId);
            } catch (err) {
              captureError(err, { context: "onboarding_apply_provider_key" });
            }
          }

          handleHatchReady();
        } catch {
          clearLocalHatch();
          if (cancelled) return;
          setError("Failed to hatch local assistant. Check CLI logs for details.");
        }
        return;
      }

      const platformPromise = getPlatformHatchPromise();
      if (!platformPromise) {
        void navigate(getOnboardingEntrypoint(), { replace: true });
        return;
      }
      try {
        const result = await platformPromise;
        clearPlatformHatch();
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
        clearPlatformHatch();
        captureError(err, { context: "onboarding_hatch_assistant" });
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
          if (result.ok) {
            const assistantId = result.data.id;
            fetchCharacterTraits(assistantId).then((existing) => {
              if (existing) return;
              return saveCharacterTraits(assistantId, hatchTraits);
            }).catch((err) => {
              captureError(err, { context: "onboarding_avatar_sync" });
            });
            if (isLocalMode()) {
              void saveLockfileAssistant({
                assistantId,
                cloud: "vellum",
                runtimeUrl: window.location.origin,
                hatchedAt: new Date().toISOString(),
              });
            }
          }

          handleHatchReady();
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
        captureError(err, { context: "onboarding_poll_assistant" });
        if (cancelled) return;
        scheduleNextPoll(POLL_INTERVAL_MS);
      }
    };

    void startHatch();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (navigateTimer) clearTimeout(navigateTimer);
      if (readyPollTimer) clearTimeout(readyPollTimer);
    };
  // sessionStatus and userId are read via refs — they inform the
  // initial gate decision but must not restart a running hatch when
  // the platform-session probe settles and changes them mid-flow.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    attempt,
    hatchTraits,
    isReplay,
    navigate,
    setOnboardingCompleted,
    transitionPhase,
    useLocalHatch,
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
                if (useLocalHatch) {
                  triggerLocalHatch();
                } else {
                  triggerPlatformHatch();
                }
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
                  useLocalHatch
                    ? routes.onboarding.hosting
                    : isReplay
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
