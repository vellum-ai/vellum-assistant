import { captureError } from "@/lib/sentry/capture-error";
import * as Sentry from "@sentry/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  getAssistant,
  getAssistantHealthz,
  hatchAssistant,
  type Assistant,
} from "@/assistant/api";
import { seedHatchAvatar } from "@/assistant/seed-hatch-avatar";
import {
  isPlatformHostedDisabled,
  PLATFORM_HOSTED_DISABLED_MESSAGE,
  resolveAssistantLifecycleState,
  shouldRecoverFromHatchFailure,
} from "@/assistant/lifecycle";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { OnboardingLayout } from "@/components/onboarding-layout";
import {
  readSelectedVersion,
  writeSelectedVersion,
} from "@/domains/onboarding/prefs";
import {
  applyPendingProviderKey,
  ProviderKeyRejectedError,
} from "@/domains/onboarding/provider-key";
import { onboardingProvider } from "@/domains/onboarding/provider-catalog";
import {
  NEW_ASSISTANT_PARAM,
  shouldSkipResearchAfterHatch,
} from "@/domains/onboarding/onboarding-destination";
import { ATTRIBUTED_PLUGIN_PARAM } from "@/domains/onboarding/plugin-attribution";
import {
  awaitPurchasedProvisioning,
  MAX_HATCH_WAIT_MS,
  POLL_INTERVAL_MS,
} from "@/domains/onboarding/purchased-provisioning";
import {
  isLocalClient,
  loadLockfile,
  primeLocalGatewayConnection,
  probeLocalGatewayReady,
  saveManagedLockfileAssistant,
} from "@/lib/local-mode";
import { clearGatewayToken } from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import {
  POST_CHECKOUT_HATCH_PARAM,
  resolveNavigation,
} from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { hatchLocalAssistant } from "@/runtime/local-mode-host";
import { isElectron } from "@/runtime/is-electron";
import { setSelectedAssistant } from "@/assistant/selection";
import { useAuthStore } from "@/stores/auth-store";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";
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
import { useTranslation } from "@/i18n";

const COMPLETION_NAVIGATE_DELAY_MS = 800;

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
let localHatchPromise: Promise<
  import("@/runtime/local-mode-host").LocalHatchResult
> | null = null;
// The hosting mode (`--remote` arg) the held localHatchPromise was created
// with. A held promise only answers for the SAME mode: the guard can outlive
// a trip through the hosting screen (the rejected-key hold below), where the
// user may switch Local <-> Docker, and the abandoned mode's assistant must
// not be adopted for the new choice.
let localHatchRemote: string | undefined;
let platformHatchPromise: Promise<
  import("@/assistant/api").HatchResult
> | null = null;
let hatchTraitsCache: CharacterTraits | null = null;

function releaseHatchGuards(): void {
  localHatchPromise = null;
  localHatchRemote = undefined;
  platformHatchPromise = null;
  hatchTraitsCache = null;
}

type HatchPhase =
  "initializing" | "provisioning" | "connecting" | "resizing" | "ready";

const PHASE_TARGET: Record<HatchPhase, number> = {
  initializing: 0,
  provisioning: 0.33,
  connecting: 0.66,
  resizing: 0.85,
  ready: 1.0,
};

const SEGMENT_DURATION_MS = 1500;

// Written out per phase rather than composed from the phase name, so a phase
// added without its copy fails to compile and the key stays greppable for the
// orphan check in `catalogs.test.ts`.
const PHASE_KEY: Record<HatchPhase, `hatchingScreen.phase.${HatchPhase}`> = {
  initializing: "hatchingScreen.phase.initializing",
  provisioning: "hatchingScreen.phase.provisioning",
  connecting: "hatchingScreen.phase.connecting",
  resizing: "hatchingScreen.phase.resizing",
  ready: "hatchingScreen.phase.ready",
};

export function interpolateSegmentProgress(
  segmentStart: number,
  target: number,
  elapsedMs: number,
): number {
  if (segmentStart >= target) {
    return target;
  }
  const t = Math.min(1.0, elapsedMs / SEGMENT_DURATION_MS);
  const eased = 1.0 - Math.pow(1.0 - t, 3.0);
  return segmentStart + (target - segmentStart) * eased;
}

export type HatchGateDecision =
  { kind: "proceed" } | { kind: "wait" } | { kind: "redirect"; to: string };

export function decideHatchGate(): HatchGateDecision {
  const decision = resolveNavigation(buildNavigationState(), {
    kind: "hatch-gate",
  });
  if (decision.action === "redirect") {
    return { kind: "redirect", to: decision.to };
  }
  if (decision.action === "wait") {
    return { kind: "wait" };
  }
  return { kind: "proceed" };
}

export function HatchingScreen() {
  const { t } = useTranslation("onboarding");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const hostingParam = searchParams.get("hosting");
  const failParam = searchParams.get("fail");
  // Marketing plugin attribution, forwarded from the privacy screen. The local
  // hatch is an intermediate route on the way to research, so carry it through
  // (see `plugin-attribution`) — otherwise a local/Docker onboarding drops it.
  const pluginParam = searchParams.get(ATTRIBUTED_PLUGIN_PARAM);
  const electron = isElectron();
  const useLocalHatch =
    isLocalClient() && hostingParam !== null && hostingParam !== "vellum-cloud";
  // `hosting=vellum-cloud` names a managed hatch even in a local-mode build
  // (see `adopt-existing-assistant`): the assistant is provisioned on the
  // platform, so its purchased machine and storage are waited for.
  const managedHatch = hostingParam === "vellum-cloud";
  // This hatch is the return leg of a completed checkout — only the
  // post-checkout funnel sets the param, and only for a billing landing
  // carrying Stripe's `session_id`. `managedHatch` is NOT a substitute: it
  // names a hosting choice a free user can make too.
  const postCheckoutReturn =
    searchParams.get(POST_CHECKOUT_HATCH_PARAM) === "1";
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
  // The provider rejected the entered API key (daemon-side validation). The
  // error screen swaps its retry for an "Update API key" path back to the
  // key screen; the hatch guards stay held so the corrected pass reuses the
  // already-hatched assistant instead of hatching a second one.
  const [apiKeyRejected, setApiKeyRejected] = useState(false);
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
    if (decision.kind === "wait") {
      return;
    }

    // A managed hatch in a local-mode build must address the platform, not the
    // machine's own gateway: `getAssistant()` answers from the selected
    // lockfile entry while a gateway token is held, and daemon SDK calls (the
    // healthz probes below) rewrite to the local gateway while a self-hosted
    // connection is primed. Dropping both is the same handoff the hosting
    // screen performs for its Vellum Cloud choice.
    if (managedHatch && isLocalClient()) {
      clearGatewayToken();
      setSelfHostedConnection(null);
    }

    setPlatformHostedDisabled(false);
    setApiKeyRejected(false);

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

    const handleHatchReady = (readyAssistantId?: string) => {
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
        if (cancelled) {
          return;
        }
        // The hatch succeeded and we're leaving this screen for good. Release
        // the module-level guards so a later onboarding session (e.g. after
        // retiring this assistant) hatches a brand-new one instead of reusing
        // this resolved promise and avatar.
        releaseHatchGuards();
        void (async () => {
          await lifecycleService.checkAssistant();
          if (cancelled) {
            return;
          }
          // Non-production skip-to-chat: the assistant is live, so drop into
          // the workspace instead of the research/personality funnel.
          if (shouldSkipResearchAfterHatch(searchParams)) {
            void navigate(`${routes.assistant}?onboarding=1`, {
              replace: true,
            });
            return;
          }
          // A local hatch feeds the research/personality flow. The assistant is
          // live, so the research route adopts it (its background hatch resolves
          // the existing local assistant instead of provisioning a managed one).
          // Any non-local hatch that lands here falls through to the same
          // research route below.
          if (useLocalHatch) {
            // Carry the hosting choice through so the research route's
            // background hatch ADOPTS this just-hatched local assistant instead
            // of running a managed hatch (see `adoptExisting` there), and the
            // assistant id so it adopts exactly this one — not whatever a stale
            // selection or leftover lockfile entry resolves to.
            const researchParams = new URLSearchParams();
            if (hostingParam) {
              researchParams.set("hosting", hostingParam);
            }
            if (readyAssistantId) {
              researchParams.set("assistant", readyAssistantId);
            }
            if (pluginParam) {
              researchParams.set(ATTRIBUTED_PLUGIN_PARAM, pluginParam);
            }
            const researchQs = researchParams.toString();
            void navigate(
              `${routes.onboarding.research}${researchQs ? `?${researchQs}` : ""}`,
              { replace: true },
            );
            return;
          }
          void navigate(routes.onboarding.research, { replace: true });
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
            if (isLocalClient()) {
              void saveManagedLockfileAssistant(
                existing.data.id,
                existing.data.name,
                getActiveOrganizationIdForRequests() ?? undefined,
              );
            }
            // Route the reload path through the same provisioning wait as the
            // polled-active path so a purchased resize is never skipped.
            await finishActiveHatch(existing.data.id);
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
        if (cancelled) {
          return;
        }
      }

      // Local/Docker hatch lifecycle:
      // 1. hatchLocalAssistant() runs the CLI (Vite middleware on web/dev,
      //    main process over IPC in Electron) to spawn the daemon + gateway
      // 2. Reload lockfile to discover the new assistant
      // 3. Acquire gateway token + set self-hosted connection
      // 4. Navigate to pre-chat flow
      if (useLocalHatch) {
        try {
          const remote = hostingParam === "docker" ? "docker" : undefined;
          // A promise held across the rejected-key hold answers only for the
          // hosting mode it was created with; a switched mode hatches fresh.
          if (localHatchPromise && localHatchRemote !== remote) {
            releaseHatchGuards();
          }
          if (!localHatchPromise) {
            localHatchRemote = remote;
            localHatchPromise = hatchLocalAssistant(undefined, remote);
          }
          // Keep `localHatchPromise` set through the rest of the flow. The
          // connectLocalAssistant() handoff below remounts this screen (see the
          // module-level comment); the fresh instance must await this same
          // resolved promise instead of starting a second hatch. Released only
          // on failure (below / catch) and on completion (handleHatchReady).
          const result = await localHatchPromise;
          if (cancelled) {
            return;
          }
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
            if (await probeLocalGatewayReady()) {
              clearGatewayToken();
              await primeLocalGatewayConnection();
              gatewayReady = true;
              break;
            }
            if (Date.now() - pollStartMs >= MAX_HATCH_WAIT_MS) {
              // The hatch succeeded but the gateway never went healthy. We never
              // reached connectLocalAssistant(), so no remount occurred — release
              // the guards so "Try again" runs a genuinely fresh hatch.
              releaseHatchGuards();
              setError(
                "Your assistant is taking longer than expected. Please try again.",
              );
              return;
            }
            await new Promise<void>((resolve) => {
              readyPollTimer = setTimeout(resolve, POLL_INTERVAL_MS);
            });
            readyPollTimer = null;
          }
          if (cancelled) {
            return;
          }

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
              if (err instanceof ProviderKeyRejectedError) {
                // The assistant hatched fine; only the entered key is bad.
                // Surface a correctable error and hold here, KEEPING the
                // module-level hatch guards: the user returns via the API-key
                // screen and this screen re-adopts the same live assistant
                // instead of hatching a duplicate. The pending selection
                // (rejected key included) was re-staged by
                // applyPendingProviderKey, so a reload here re-applies it and
                // lands back on this screen rather than proceeding keyless.
                if (!cancelled) {
                  const displayName =
                    onboardingProvider(err.provider)?.displayName ??
                    err.provider;
                  setApiKeyRejected(true);
                  const action = `Update your ${displayName} API key to continue.`;
                  setError(err.reason ? `${err.reason} ${action}` : action);
                }
                return;
              }
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

          handleHatchReady(result.assistantId);
        } catch {
          releaseHatchGuards();
          if (cancelled) {
            return;
          }
          setError(
            "Failed to hatch local assistant. Check CLI logs for details.",
          );
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
        if (cancelled) {
          return;
        }
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
        if (cancelled) {
          return;
        }
      }

      scheduleNextPoll(0);
    };

    const scheduleNextPoll = (delay: number) => {
      if (cancelled) {
        return;
      }
      pollTimer = setTimeout(runPoll, delay);
    };

    // Both the preflight-active path (a reload onto an already-active assistant)
    // and the polled-active path converge here: wait for healthz, hold for the
    // purchased resize, then complete. Sharing this tail keeps a reload from
    // skipping the provisioning wait.
    const finishActiveHatch = async (assistantId: string): Promise<void> => {
      // The platform may report "active" before the pod is ready to serve, so
      // wait for the daemon to answer healthz before holding for the resize.
      transitionPhase("connecting");
      while (!cancelled) {
        try {
          const health = await getAssistantHealthz(assistantId);
          if (health.ok) {
            break;
          }
        } catch {
          // Daemon not reachable yet.
        }
        if (Date.now() - pollStartMs >= MAX_HATCH_WAIT_MS) {
          setError(
            "Your assistant is taking longer than expected. Please try again.",
          );
          return;
        }
        await new Promise<void>((resolve) => {
          pollTimer = setTimeout(resolve, POLL_INTERVAL_MS);
        });
        pollTimer = null;
      }
      if (cancelled) {
        return;
      }

      const outcome = await awaitPurchasedProvisioning({
        assistantId,
        postCheckoutReturn,
        managedHatch,
        hatchStartMs: pollStartMs,
        isCancelled: () => cancelled,
        onResizeWait: () => transitionPhase("resizing"),
        registerTimer: (timer) => {
          pollTimer = timer;
        },
      });
      if (cancelled) {
        return;
      }
      if (outcome === "health_timeout") {
        // The provisioning wait ran its course but the assistant never came
        // back. Completing here would hand the user an unreachable assistant,
        // so surface the same recoverable failure the other hatch timeouts do.
        Sentry.captureMessage("Onboarding hatch wait exceeded timeout", {
          level: "warning",
          extra: { maxWaitMs: MAX_HATCH_WAIT_MS, stage: "post_resize_health" },
        });
        setError(
          "Your assistant is taking longer than expected. Please try again.",
        );
        return;
      }

      handleHatchReady();
    };

    const runPoll = async () => {
      if (cancelled) {
        return;
      }
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
        if (cancelled) {
          return;
        }
        // If the hatched ID 404s (e.g. stale after refresh, or backend
        // assigned a different ID), fall back to list-based discovery.
        if (hatchedAssistantId && !result.ok && result.status === 404) {
          hatchedAssistantId = undefined;
          result = await getAssistant();
          if (cancelled) {
            return;
          }
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
            if (isLocalClient()) {
              void saveManagedLockfileAssistant(
                assistantId,
                result.data.name,
                getActiveOrganizationIdForRequests() ?? undefined,
              );
            }

            // Wait for healthz, then hold for the purchased resize before
            // completing (platform hatches only; local hatches never reach this
            // poll loop).
            await finishActiveHatch(assistantId);
            return;
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
        if (cancelled) {
          return;
        }
        scheduleNextPoll(POLL_INTERVAL_MS);
      }
    };

    void startHatch();

    return () => {
      cancelled = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      if (navigateTimer) {
        clearTimeout(navigateTimer);
      }
      if (readyPollTimer) {
        clearTimeout(readyPollTimer);
      }
    };
  }, [
    attempt,
    failParam,
    hatchTraits,
    managedHatch,
    postCheckoutReturn,
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
      <OnboardingLayout avatarWave="beside">
        <div
          role="alert"
          className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-28 electron-prechat-type" : "min-h-screen justify-center px-6 pb-40 md:min-h-full md:pb-6"} text-center text-[var(--content-default)]`}
        >
          <h1
            className={
              electron
                ? "text-title-large"
                : "text-3xl font-semibold tracking-tight"
            }
          >
            {apiKeyRejected
              ? t("hatchingScreen.apiKeyFailed")
              : t("hatchingScreen.genericFailure")}
          </h1>
          <p
            className={`text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-4"}`}
          >
            {error}
          </p>
          {platformHostedDisabled && (
            <div className="mt-6 flex w-full max-w-sm flex-col items-center gap-3">
              <p className="text-body-medium-default text-[var(--content-default)]">
                {t("hatchingScreen.localFallbackPitch")}
              </p>
              <Button
                asChild
                variant="primary"
                size="regular"
                fullWidth
                className={electron ? undefined : "h-11 text-base"}
              >
                <a href={`${window.location.origin}/download`}>
                  {t("actions.downloadMacApp")}
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
          <div
            className={`flex w-full flex-col ${electron ? "gap-2.5 max-w-[280px]" : "gap-2 max-w-sm"}`}
          >
            {apiKeyRejected ? (
              <Button
                variant="primary"
                size="regular"
                fullWidth
                className={electron ? undefined : "h-11 text-base"}
                onClick={() =>
                  void navigate(
                    hostingParam
                      ? `${routes.onboarding.apiKey}?hosting=${hostingParam}`
                      : routes.onboarding.apiKey,
                    { replace: true },
                  )
                }
              >
                {t("hatchingScreen.updateApiKey")}
              </Button>
            ) : (
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
                {t("actions.tryAgain")}
              </Button>
            )}
            <Button
              variant="outlined"
              size="regular"
              fullWidth
              className={electron ? undefined : "h-11 text-base"}
              onClick={() =>
                void navigate(
                  useLocalHatch
                    ? routes.onboarding.hosting
                    : `${routes.onboarding.privacy}?${NEW_ASSISTANT_PARAM}=1`,
                  { replace: true },
                )
              }
            >
              {t("actions.back")}
            </Button>
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout avatarWave="beside">
      {/* Electron layout: title pinned 84px from the window top (the shared
          step-title position), the creature centered in the leftover space via
          auto margins, and the progress section near the bottom — pb-28 keeps
          it clear of the fixed CreatureFooter art below the progress bar. The
          bar caps at 200px with a 10px label. Web/iOS keep the centered
          layout. */}
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-28 electron-prechat-type" : "min-h-screen justify-center px-6 pb-40 md:min-h-full md:pb-6"} text-center text-[var(--content-default)]`}
      >
        <h1
          className={
            electron
              ? "text-title-large"
              : "text-3xl font-semibold tracking-tight"
          }
        >
          {phase === "ready"
            ? t("hatchingScreen.ready")
            : t("hatchingScreen.waking")}
        </h1>
        {phase !== "ready" && (
          <p
            className={`text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-4"}`}
          >
            {t("hatchingScreen.wakingBody")}
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
          aria-label={t("hatchingScreen.progressAriaLabel")}
        />
        <p
          className={`text-[var(--content-tertiary)] ${electron ? "mt-4 text-label-small-default" : "mt-3 text-body-small-default"}`}
        >
          {t(PHASE_KEY[phase])}
        </p>
      </div>
    </OnboardingLayout>
  );
}
