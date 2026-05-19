import type { Route } from "@/types/route.js";

import * as Sentry from "@sentry/react";
import { useNavigate, useSearchParams } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ProgressBar } from "@vellum/design-library/components/progress-bar";
import { OnboardingLayout } from "@/components/app/onboarding/OnboardingLayout.js";
import { extractErrorMessage } from "@/lib/api/errors.js";
import { getAssistant, hatchAssistant } from "@/lib/assistants/api.js";
import { fetchCharacterTraits, saveCharacterTraits } from "@/lib/avatar/api.js";
import { BUNDLED_COMPONENTS } from "@/lib/avatar/bundled-components.js";
import { randomCharacterTraits } from "@/lib/avatar/random.js";
import { composeSvg } from "@/lib/avatar/svg-compositor.js";
import type { CharacterTraits } from "@/lib/avatar/types.js";
import {
  isPlatformHostedDisabled,
  PLATFORM_HOSTED_DISABLED_MESSAGE,
  resolveAssistantLifecycleState,
  shouldRecoverFromHatchFailure,
} from "@/lib/assistants/lifecycle.js";
import { useAuth } from "@/lib/auth.js";
import {
  readAiDataConsent,
  readOnboardingCompleted,
  readSelectedVersion,
  readTosAccepted,
  writeSelectedVersion,
} from "@/lib/onboarding/prefs.js";
import {
  hasRecentPrivacyConsent,
  markPrivacyConsent,
} from "@/lib/onboarding/signals.js";
import { routes } from "@/lib/routes.js";

const POLL_INTERVAL_MS = 3000;
// Small delay after the assistant becomes active so the progress bar has time
// to animate from its current value up to 100% before we navigate away.
const COMPLETION_NAVIGATE_DELAY_MS = 800;
// Hard upper bound on how long we'll poll before surfacing an error to the
// user. Generous but bounded so a stuck `initializing` / `auto_hatch` state
// can't leave the user waiting forever.
const MAX_HATCH_WAIT_MS = 300_000;

// Each segment eases from the current displayed value to its phase target
// over SEGMENT_DURATION_MS using a cubic ease-out, matching the macOS
// managed hatch progress bar.
type HatchPhase = "initializing" | "provisioning" | "connecting" | "ready";

const PHASE_TARGET: Record<HatchPhase, number> = {
  initializing: 0,
  provisioning: 0.33,
  connecting: 0.66,
  ready: 1.0,
};

const SEGMENT_DURATION_MS = 1500;

const PHASE_LABEL: Record<HatchPhase, string> = {
  initializing: "Setting up your assistant…",
  provisioning: "Provisioning assistant…",
  connecting: "Connecting to assistant…",
  ready: "Ready",
};

/**
 * Cubic ease-out interpolation for a single progress segment. Each phase
 * eases from `segmentStart` (the displayed value when the phase began) to
 * `target` over `SEGMENT_DURATION_MS` using `1 - (1-t)³`. Exported for
 * unit tests so the curve can be asserted without threading timers through
 * the component.
 */
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

/**
 * Pure gate decision for `/onboarding/hatching` mount. Exported for tests —
 * the effect body just glues the inputs (feature flag, stored prefs, URL
 * signal) together and applies the result via `router.replace` / fall
 * through to hatching.
 */
export type HatchGateDecision =
  // `wait` covers the brief window where `useAuth` is still resolving the
  // session — the effect short-circuits without hatching or redirecting,
  // and re-runs once `isAuthLoading` flips.
  | { kind: "proceed" }
  | { kind: "wait" }
  | { kind: "redirect"; to: Route };

export function decideHatchGate(input: {
  isAuthLoading: boolean;
  isLoggedIn: boolean;
  onboardingCompleted: boolean;
  tosAccepted: boolean;
  aiDataConsentAccepted: boolean;
  cameFromPrivacyScreen: boolean;
}): HatchGateDecision {
  // Defer every other decision until auth resolves. Hatch/poll requests
  // require a session; firing them before `isLoggedIn` is known yields a
  // generic failure instead of the proper login redirect.
  if (input.isAuthLoading) return { kind: "wait" };
  if (!input.isLoggedIn) return { kind: "redirect", to: routes.account.login };
  if (input.onboardingCompleted) return { kind: "redirect", to: routes.assistant };
  // Consent gate — the user must have either passed through the privacy
  // screen this session (in-memory signal) or have BOTH persisted
  // acknowledgments on disk. The persisted check requires both flags
  // because `PrivacyScreen.onStart` writes them together; observing only
  // one means consent state is partial / corrupt and we should re-collect
  // rather than provision an assistant on incomplete consent. The
  // in-memory signal alone is sufficient on storage-disabled browsers
  // where persistence is a no-op.
  const persistedConsent = input.tosAccepted && input.aiDataConsentAccepted;
  if (!input.cameFromPrivacyScreen && !persistedConsent) {
    return { kind: "redirect", to: routes.onboarding.privacy };
  }
  return { kind: "proceed" };
}

export function HatchingScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // `?replay=1` is set by the Vellum-only debug "Replay onboarding" action.
  // In replay mode we skip the `hatchAssistant()` call entirely — the user
  // already has an active assistant and we just want to walk them back
  // through the onboarding screens. The poll loop catches the existing
  // active assistant and completes the flow normally. Without this gate,
  // Vellum users with the multi-platform-assistant flag enabled would get
  // a brand-new duplicate assistant on every replay (see
  // `_is_vellum_user` branch in `django/app/assistant/views.py:hatch`).
  const isReplay = searchParams.get("replay") === "1";
  const { userId, isLoggedIn, isLoading: isAuthLoading } = useAuth();
  const [hatchTraits] = useState<CharacterTraits>(() =>
    randomCharacterTraits(),
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
  // Tracks whether the current error originated from the
  // `platform-hosted-enabled` capacity gate (503 + `platform_hosted_disabled`).
  // When true, the error screen offers a secondary "Get started today with a
  // local assistant" CTA so users can fall through to the macOS app instead
  // of bouncing on Try again until the capacity gate flips back on.
  const [platformHostedDisabled, setPlatformHostedDisabled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // `displayProgress` is the value actually fed into `ProgressBar`. It
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
    // Non-mutating read so React strict-mode double mounts (and effect
    // re-runs from Try-again retries on storage-disabled browsers) all
    // see the marker as valid. `clearPrivacyConsent` fires only once the
    // hatch actually succeeds — keeping the marker alive through retries
    // of a failed attempt is what makes the fallback path work.
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
      navigate(decision.to, { replace: true });
      return;
    }
    // Auth still resolving — the effect re-runs when `isAuthLoading`
    // flips (it's in the deps), so just bail out for now.
    if (decision.kind === "wait") return;

    // Reset the capacity-CTA flag at the start of every effect run. The
    // effect re-runs not just from "Try again" (which clears it) but also
    // when its other deps change. Without this reset, a stale `true`
    // from a previous run would leave the "Download the macOS app" CTA
    // attached to a *different* error message produced by the new run.
    setPlatformHostedDisabled(false);

    // Effect-scoped cancellation so retry-triggered re-runs don't race with
    // the prior run's in-flight hatch + poll.
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let navigateTimer: ReturnType<typeof setTimeout> | null = null;
    const pollStartMs = Date.now();

    // Read the pinned release version once per effect run. Only present
    // in nonprod (the privacy screen's dev-only picker writes it); empty
    // string falls through to the managed "latest" default.
    const pinnedVersion = readSelectedVersion();

    const startHatch = async () => {
      // Transition out of the initial "Setting up" label into provisioning
      // now that the hatch request is about to fire.
      transitionPhase("provisioning");
      // Replay mode: skip the hatch call entirely so we don't spawn a
      // duplicate assistant. The poll loop runs as normal and will catch
      // the user's existing active assistant on its first tick.
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
          // Capacity / kill-switch from the backend (platform-hosted-enabled
          // flag is off). We must check this BEFORE the generic 5xx-recovery
          // branch — 503 would otherwise fall through to polling and the
          // user would see a generic timeout instead of the at-capacity
          // message.
          if (isPlatformHostedDisabled(result.status, result.error)) {
            setError(PLATFORM_HOSTED_DISABLED_MESSAGE);
            setPlatformHostedDisabled(true);
            return;
          }
          if (shouldRecoverFromHatchFailure(result.status)) {
            // Recoverable (5xx / network) — fall through to the polling loop,
            // which will either observe the assistant coming up or surface
            // its own error.
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
        // Network-style exception — keep polling; poll loop will escalate if
        // the backend is persistently unhealthy.
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
          // Hatching is not the last step of onboarding —
          // PreChatFlow.finish() owns the completion flag. Setting
          // `onboarding.completed=true` here would make PreChatFlow's
          // gate immediately redirect the user to /assistant, skipping
          // the flow entirely.
          //
          // The dev-only release pin is dropped now (it's
          // hatching-scoped, not PreChat-scoped) so a re-onboard later
          // picks up whatever "latest" is at that moment rather than a
          // stale dev pin from this session.
          //
          // Guard against localStorage being disabled / over quota — if
          // the write throws we still want to navigate.
          try {
            writeSelectedVersion("");
          } catch (err) {
            Sentry.captureException(err, {
              tags: { context: "onboarding_mark_completed" },
            });
          }
          // Refresh the in-memory consent marker so its 30s TTL covers
          // the upcoming PreChat mount even if the hatch took longer
          // than 30s (`MAX_HATCH_WAIT_MS=300s` allows hatches well
          // past the marker's original lifetime). Without the refresh,
          // storage-disabled browsers (where `readTosAccepted()` is
          // false and the in-memory marker is the only consent signal)
          // would loop privacy → hatching → prechat → privacy on slow
          // hatches. PreChatFlow.finish() owns the eventual clear.
          markPrivacyConsent(userId);

          // Sync random character traits to the daemon so the assistant
          // has a default avatar from the start — prevents 404s for
          // avatar-image.png and character-traits.json on first load.
          // Fire-and-forget: don't block navigation on this.
          // Guard: skip if the assistant already has traits (re-onboarding
          // with an existing assistant shouldn't overwrite a custom avatar).
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

          // Snap to 100% immediately — don't ease. The navigate delay is
          // shorter than the segment duration, and the user should see a
          // completed bar before we leave the page. Setting segmentStartRef
          // to 1 ensures that any surviving rAF loop from a prior phase
          // computes interpolateSegmentProgress(1, 1, …) = 1 on its next
          // tick, so it terminates via the epsilon guard without flickering
          // the bar back to an intermediate value.
          setDisplayProgress(1);
          displayProgressRef.current = 1;
          segmentStartRef.current = 1;
          setPhase("ready");
          phaseRef.current = "ready";
          navigateTimer = setTimeout(() => {
            if (cancelled) return;
            // Route through `/onboarding/prechat` — the page itself
            // sets the `?onboarding=1` signal on completion, so the
            // auto-greet still fires once the user reaches `/assistant`.
            navigate(routes.onboarding.prechat, { replace: true });
          }, COMPLETION_NAVIGATE_DELAY_MS);
          return;
        }
        if (next.kind === "error") {
          setError(next.message);
          return;
        }
        // `auto_hatch` (404) = Django record not created yet → stay in
        // provisioning. Anything else → record exists, advance once.
        // (Fast path where `active` is observed directly skips connecting;
        // that's intentional — the bar reflects backend state as seen.)
        if (next.kind !== "auto_hatch" && phaseRef.current === "provisioning") {
          transitionPhase("connecting");
        }
        scheduleNextPoll(POLL_INTERVAL_MS);
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "onboarding_poll_assistant" },
        });
        if (cancelled) return;
        // Keep trying — transient fetch failures shouldn't kill the flow.
        scheduleNextPoll(POLL_INTERVAL_MS);
      }
    };

    void startHatch();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (navigateTimer) clearTimeout(navigateTimer);
    };
    // `router` is stable across renders per Next.js docs; `attempt` is the
    // retry counter that re-runs the effect when the user clicks "Try again".
  }, [
    attempt,
    hatchTraits,
    isAuthLoading,
    isLoggedIn,
    isReplay,
    navigate,
    transitionPhase,
    userId,
  ]);

  // requestAnimationFrame-driven progress animation. Restarts whenever
  // `animationEpoch` bumps (on mount and on each phase transition). The
  // loop reads segment parameters from refs so it doesn't restart on
  // every phase change — only on explicit epoch bumps. Self-terminates
  // when the segment reaches its target.
  useEffect(() => {
    // Lazily seed the segment start time on the first tick if it hasn't
    // been set yet (initial mount). `Date.now()` is impure and can't be
    // called during render, so we defer to the first effect run.
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
          {/* typography: off-scale — hero onboarding h1 (30px) intentionally larger than text-title-large (24px) to match macOS onboarding visual weight */}
          { }
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
                // typography: off-scale — CTA upsize to match the Try again /
                // Back buttons rendered below
                 
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
              // typography: off-scale — CTA upsize; Button primitive only exposes regular/compact so text-base forces the spec's 16px "lg" size
               
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
              // typography: off-scale — CTA upsize paired with the Try again button above
               
              className="h-11 text-base"
              onClick={() =>
                isReplay
                  ? navigate(`${routes.onboarding.privacy}?replay=1`, { replace: true })
                  : navigate(routes.onboarding.privacy)
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
        {/* typography: off-scale — hero onboarding h1 (30px) intentionally larger than text-title-large (24px) to match macOS onboarding visual weight */}
        { }
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
