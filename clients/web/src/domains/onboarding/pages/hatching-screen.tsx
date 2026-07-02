import { captureError } from "@/lib/sentry/capture-error";
import * as Sentry from "@sentry/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { getAssistant, getAssistantHealthz, hatchAssistant, type Assistant } from "@/assistant/api";
import { seedHatchAvatar } from "@/assistant/seed-hatch-avatar";
import {
    isPlatformHostedDisabled,
    PLATFORM_HOSTED_DISABLED_MESSAGE,
    resolveAssistantLifecycleState,
    shouldRecoverFromHatchFailure,
} from "@/assistant/lifecycle";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
    readSelectedVersion,
    writeSelectedVersion,
} from "@/domains/onboarding/prefs";
import { applyPendingProviderKey } from "@/domains/onboarding/provider-key";
import { getLocalGatewayUrl, getPlatformRuntimeUrl, isLocalMode, loadLockfile, primeLocalGatewayConnection, saveLockfileAssistant } from "@/lib/local-mode";
import { clearGatewayToken } from "@/lib/auth/gateway-session";
import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { hatchLocalAssistant } from "@/runtime/local-mode-host";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";
import { setSelectedAssistant } from "@/assistant/selection";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { isSessionSettled } from "@/stores/session-status";
import type { CharacterTraits } from "@/types/avatar";
import { extractErrorMessage } from "@/utils/api-errors";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@/utils/avatar-random";
import { composeSvg } from "@/utils/avatar-svg-compositor";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";

const POLL_INTERVAL_MS = 3000;
const COMPLETION_NAVIGATE_DELAY_MS = 800;
const MAX_HATCH_WAIT_MS = 300_000;

// Module-level state so HMR remounts, StrictMode double-mounts, and — critically
// — the auth-driven provider remount survive without spawning duplicate hatches.
// The local-hatch handoff calls connectLocalAssistant(), which flips
// `sessionStatus` to "authenticated"; that changes the scope `key` on the
// query-client providers (see providers.tsx), unmounting and remounting this
// whole screen mid-flow. The remounted instance must await the SAME in-flight
// (or already-resolved) hatch — and reuse the SAME avatar traits — rather than
// start over. These guards are released only on failure (so retry re-hatches)
// and on genuine completion (so a later onboarding hatches fresh), never in the
// window between the hatch resolving and the screen navigating away.
let localHatchPromise: Promise<import("@/runtime/local-mode-host").LocalHatchResult> | null = null;
let platformHatchPromise: Promise<import("@/assistant/api").HatchResult> | null = null;
let hatchTraitsCache: CharacterTraits | null = null;

function releaseHatchGuards(): void {
  localHatchPromise = null;
  platformHatchPromise = null;
  hatchTraitsCache = null;
}

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

export function decideHatchGate(): HatchGateDecision {
  const decision = resolveNavigation(
    buildNavigationState(),
    { kind: "hatch-gate" },
  );
  if (decision.action === "redirect") return { kind: "redirect", to: decision.to };
  if (decision.action === "wait") return { kind: "wait" };
  return { kind: "proceed" };
}

export function HatchingScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const hostingParam = searchParams.get("hosting");
  const failParam = searchParams.get("fail");
  const electron = isElectron();
  const useLocalHatch = isLocalMode() && hostingParam !== null && hostingParam !== "vellum-cloud";
  const sessionStatus = useAuthStore.use.sessionStatus();
  // Local hatches drive `sessionStatus` themselves (`connectLocalAssistant`
  // below flips it mid-handoff), so they gate on settled-ness to keep that flip
  // out of the effect deps and avoid self-restarting. Platform hatches react to
  // raw status so a mid-hatch session loss redirects to login.
  const sessionGateKey = useLocalHatch
    ? isSessionSettled(sessionStatus)
    : sessionStatus;
  const [hatchTraits] = useState<CharacterTraits>(
    () => (hatchTraitsCache ??= randomCharacterTraits(BUNDLED_COMPONENTS)),
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
    // Developer "Replay Hatch Failure" tool: when opened with `?fail`, skip the
    // gate and the real hatch flow and render the error UI directly so the
    // failure screen can be exercised on demand from the Electron developer menu.
    if (failParam !== null) {
      setError(
        "Simulated hatch failure (developer menu → Replay Hatch Failure).",
      );
      return;
    }
    const decision = decideHatchGate();
    if (decision.kind === "redirect") {
      void navigate(decision.to, { replace: true });
      return;
    }
    if (decision.kind === "wait") return;

    setPlatformHostedDisabled(false);

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let navigateTimer: ReturnType<typeof setTimeout> | null = null;
    let readyPollTimer: ReturnType<typeof setTimeout> | null = null;
    const pollStartMs = Date.now();
    let hatchedAssistantId: string | undefined;
    // Two independent signals that the assistant the poll discovers is THIS
    // run's brand-new hatch (and so may be seeded with a random avatar) rather
    // than a returning user's existing one (which might carry an uploaded/AI
    // image avatar that a "no traits" read would clobber):
    //   - `createdFreshAssistant`: the hatch POST returned 201 (newly created).
    //   - `preflightFoundNoAssistant`: the pre-flight `getAssistant()` cleanly
    //     resolved `auto_hatch` (HTTP 404 = no assistant existed yet), so any
    //     later-active assistant must be this hatch — covers the case where the
    //     hatch response is lost and 201 never lands. A pre-existing non-active
    //     assistant, a thrown pre-flight, or a 5xx leaves both false, so a
    //     returning user is never re-seeded.
    let createdFreshAssistant = false;
    let preflightFoundNoAssistant = false;

    const pinnedVersion = readSelectedVersion();

    const handleHatchReady = () => {
      try {
        writeSelectedVersion("");
      } catch (err) {
        captureError(err, { context: "onboarding_mark_completed" });
      }
      setDisplayProgress(1);
      displayProgressRef.current = 1;
      segmentStartRef.current = 1;
      setPhase("ready");
      phaseRef.current = "ready";
      navigateTimer = setTimeout(() => {
        if (cancelled) return;
        // The hatch succeeded and we're leaving this screen for good. Release
        // the module-level guards so a later onboarding session (e.g. after
        // retiring this assistant) hatches a brand-new one instead of reusing
        // this resolved promise and avatar.
        releaseHatchGuards();
        void (async () => {
          await lifecycleService.checkAssistant();
          if (cancelled) return;
          if (isNativePlatform()) {
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
            routes.onboarding.prechat,
            { replace: true },
          );
        })();
      }, COMPLETION_NAVIGATE_DELAY_MS);
    };

    // Seed the random hatch avatar for a freshly hatched assistant (never an
    // already-active one — see `seedHatchAvatar` for the why). Fire-and-forget.
    const persistHatchAvatar = (assistantId: string): Promise<void> =>
      seedHatchAvatar(assistantId, hatchTraits, queryClient);

    const startHatch = async () => {
      transitionPhase("provisioning");

      // For platform hatches, check if an assistant is already active
      // (debug replay, returning user) and skip the hatch request.
      // Local hatches always need to run hatchLocalAssistant() to
      // create the local daemon, even when a cloud assistant exists.
      if (!useLocalHatch) {
        try {
          const existing = await getAssistant();
          const preflightState = resolveAssistantLifecycleState(existing);
          if (!cancelled && existing.ok && preflightState.kind === "active") {
            if (isLocalMode()) {
              void saveLockfileAssistant({
                assistantId: existing.data.id,
                name: existing.data.name,
                cloud: "vellum",
                runtimeUrl: getPlatformRuntimeUrl(),
                hatchedAt: new Date().toISOString(),
                organizationId:
                  useOrganizationStore.getState().currentOrganizationId ?? undefined,
              });
            }
            handleHatchReady();
            return;
          }
          // A clean 404 (`auto_hatch`) means no assistant existed yet, so the
          // assistant the poll later finds active is necessarily this run's
          // fresh hatch — seedable even if the hatch response is lost.
          if (preflightState.kind === "auto_hatch") {
            preflightFoundNoAssistant = true;
          }
        } catch {
          // Fall through to normal hatch
        }
        if (cancelled) return;
      }

      // Local/Docker hatch lifecycle:
      // 1. hatchLocalAssistant() runs the CLI (Vite middleware on web/dev,
      //    main process over IPC in Electron) to spawn the daemon + gateway
      // 2. Reload lockfile to discover the new assistant
      // 3. Acquire gateway token + set self-hosted connection
      // 4. Navigate to pre-chat flow
      if (useLocalHatch) {
        try {
          if (!localHatchPromise) {
            const remote = hostingParam === "docker" ? "docker" : undefined;
            localHatchPromise = hatchLocalAssistant(undefined, remote);
          }
          // Keep `localHatchPromise` set through the rest of the flow. The
          // connectLocalAssistant() handoff below remounts this screen (see the
          // module-level comment); the fresh instance must await this same
          // resolved promise instead of starting a second hatch. Released only
          // on failure (below / catch) and on completion (handleHatchReady).
          const result = await localHatchPromise;
          if (cancelled) return;
          if (!result.ok) {
            releaseHatchGuards();
            setError(result.error ?? "Failed to hatch local assistant.");
            return;
          }
          await loadLockfile();
          if (result.assistantId) {
            // The selection key is written synchronously, so the /readyz loop
            // below resolves the new assistant's gateway URL. The lifecycle's
            // selection subscription may briefly point at the not-yet-ready
            // gateway; the re-prime below converges it.
            void setSelectedAssistant(result.assistantId);
          }

          // Wait for the gateway + daemon to be fully ready before proceeding.
          // The CLI's hatch command spawns them as background processes and exits
          // before they finish starting up. We poll /readyz (gateway + upstream
          // daemon) and then attempt to acquire the gateway auth token. Both must
          // succeed before we navigate away — the guardian token file may not
          // exist on disk until after /readyz passes.
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
                    clearGatewayToken();
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
              // The hatch succeeded but the gateway never went healthy. We never
              // reached connectLocalAssistant(), so no remount occurred — release
              // the guards so "Try again" runs a genuinely fresh hatch.
              releaseHatchGuards();
              setError("Your assistant is taking longer than expected. Please try again.");
              return;
            }
            await new Promise<void>(resolve => {
              readyPollTimer = setTimeout(resolve, POLL_INTERVAL_MS);
            });
            readyPollTimer = null;
          }
          if (cancelled) return;

          // Apply the model-provider key collected on the API-key step to
          // the freshly hatched assistant. Runs BEFORE connectLocalAssistant
          // because that call flips sessionStatus and remounts the component
          // tree (see the module-level comment). The gateway token acquired by
          // primeLocalGatewayConnection() above is sufficient for the daemon
          // SDK calls; running them here avoids a race where the remounted
          // instance navigates away before the provider setup completes.
          if (result.assistantId) {
            try {
              await applyPendingProviderKey(result.assistantId);
            } catch (err) {
              captureError(err, { context: "onboarding_apply_provider_key" });
            }
          }

          // Assert an authenticated local session via the same canonical
          // connect primitive the returning-user picker and re-pair flow use,
          // so `sessionStatus` is "authenticated" at hand-off to chat. This
          // keeps auth-gated UI such as the Preferences menu visible.
          if (result.assistantId) {
            await useAuthStore
              .getState()
              .connectLocalAssistant(result.assistantId);
          }

          if (result.assistantId) {
            useResolvedAssistantsStore.getState().upsertFromApi({
              id: result.assistantId,
              name: result.assistantId,
              status: "active",
              is_local: true,
              created: new Date().toISOString(),
            } as Assistant);
            void setSelectedAssistant(result.assistantId);
            void persistHatchAvatar(result.assistantId);
          }

          handleHatchReady();
        } catch {
          releaseHatchGuards();
          if (cancelled) return;
          setError("Failed to hatch local assistant. Check CLI logs for details.");
        }
        return;
      }

      try {
        if (!platformHatchPromise) {
          platformHatchPromise = hatchAssistant(
            pinnedVersion ? { version: pinnedVersion } : undefined,
          );
        }
        const result = await platformHatchPromise;
        platformHatchPromise = null;
        if (cancelled) return;
        if (result.ok) {
          hatchedAssistantId = result.data.id;
        }
        // 201 = newly created; 200 = an existing assistant was returned.
        createdFreshAssistant = result.ok && result.status === 201;
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
        platformHatchPromise = null;
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
        let result = await getAssistant(hatchedAssistantId);
        if (cancelled) return;
        // If the hatched ID 404s (e.g. stale after refresh, or backend
        // assigned a different ID), fall back to list-based discovery.
        if (hatchedAssistantId && !result.ok && result.status === 404) {
          hatchedAssistantId = undefined;
          result = await getAssistant();
          if (cancelled) return;
        }
        const next = resolveAssistantLifecycleState(result);
        if (next.kind === "active") {
          if (result.ok) {
            const assistantId = result.data.id;
            useResolvedAssistantsStore.getState().upsertFromApi(result.data);
            void setSelectedAssistant(assistantId);
            if (createdFreshAssistant || preflightFoundNoAssistant) {
              void persistHatchAvatar(assistantId);
            }
            if (isLocalMode()) {
              void saveLockfileAssistant({
                assistantId,
                name: result.data.name,
                cloud: "vellum",
                runtimeUrl: getPlatformRuntimeUrl(),
                hatchedAt: new Date().toISOString(),
                organizationId:
                  useOrganizationStore.getState().currentOrganizationId ?? undefined,
              });
            }

            // Wait for the daemon to be reachable before navigating.
            // The platform may report "active" before the pod is
            // fully ready to serve requests.
            transitionPhase("connecting");
            while (!cancelled) {
              try {
                const health = await getAssistantHealthz(assistantId);
                if (health.ok) break;
              } catch {
                // Daemon not reachable yet
              }
              if (Date.now() - pollStartMs >= MAX_HATCH_WAIT_MS) {
                setError("Your assistant is taking longer than expected. Please try again.");
                return;
              }
              await new Promise<void>(resolve => {
                pollTimer = setTimeout(resolve, POLL_INTERVAL_MS);
              });
              pollTimer = null;
            }
            if (cancelled) return;
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
  }, [
    attempt,
    failParam,
    hatchTraits,
    sessionGateKey,
    navigate,
    queryClient,
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
          className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-28 electron-prechat-type" : "min-h-screen justify-center px-6 pb-40"} text-center text-[var(--content-default)]`}
        >
          <h1 className={electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}>
            Something went wrong
          </h1>
          <p className={`text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-4"}`}>
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
                className={electron ? undefined : "h-11 text-base"}
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
            className={`${electron ? "my-auto py-8" : "my-16"} onboarding-avatar-failed`}
          />
          <div className={`flex w-full flex-col ${electron ? "gap-2.5 max-w-[280px]" : "gap-2 max-w-sm"}`}>
            <Button
              variant="primary"
              size="regular"
              fullWidth
              className={electron ? undefined : "h-11 text-base"}
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
              className={electron ? undefined : "h-11 text-base"}
              onClick={() =>
                void navigate(
                  useLocalHatch
                    ? routes.onboarding.hosting
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
      {/* Electron layout: title pinned 84px from the window top (the shared
          step-title position), the creature centered in the leftover space via
          auto margins, and the progress section near the bottom — pb-28 keeps
          it clear of the fixed CreatureFooter art below the progress bar. The
          bar caps at 200px with a 10px label. Web/iOS keep the centered
          layout. */}
      <div className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-28 electron-prechat-type" : "min-h-screen justify-center px-6 pb-40"} text-center text-[var(--content-default)]`}>
        <h1 className={electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}>
          {phase === "ready" ? "Your assistant is ready!" : "Waking up…"}
        </h1>
        {phase !== "ready" && (
          <p className={`text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-4"}`}>
            Hang tight — your assistant will have a few questions for you once
            it&apos;s up.
          </p>
        )}
        <img
          src={avatarSvgDataUrl}
          alt=""
          width={160}
          height={160}
          className={`${electron ? "my-auto py-8" : "my-16"} ${phase === "ready" ? "onboarding-avatar-awake" : "onboarding-avatar-pulse"}`}
        />
        <ProgressBar
          value={displayProgress}
          height={6}
          className={`w-full ${electron ? "max-w-[200px]" : "max-w-sm"}`}
          aria-label="Assistant startup progress"
        />
        <p className={`text-[var(--content-tertiary)] ${electron ? "mt-4 text-label-small-default" : "mt-3 text-body-small-default"}`}>
          {PHASE_LABEL[phase]}
        </p>
      </div>
    </OnboardingLayout>
  );
}
