import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@vellumai/design-library";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { contrastForeground } from "@/utils/avatar-tone";

import {
  AvatarTour,
  type AvatarTourHandle,
  type TourProgress,
} from "./avatar-tour";
import { TourOverlay } from "./tour-overlay";
import { type TourStep } from "./tour-steps";
import {
  emitInChatTourCompleted,
  emitInChatTourSkipped,
} from "./tour-telemetry";

/**
 * Orchestrator for the in-chat onboarding tour, mounted alongside
 * `ChatLayout` so it runs over the REAL app UI.
 *
 * Activation is the hand-off from research onboarding — users' first
 * sight of the app — which plays {@link AvatarTour} immediately. The tour
 * walks the left nav beat by beat while each stop's line typewrites over
 * {@link TourOverlay}, a full-screen takeover of the app. The takeover
 * latches on the first landing so the app doesn't flash back between
 * stops, and lifts when the tour finishes. This controller renders the
 * tour's chrome below the typewriter text: back/next chevrons and Skip
 * tour.
 */
export function InChatOnboardingController() {
  const prototypeActive = useInChatOnboardingStore.use.prototypeActive();
  const stage = useInChatOnboardingStore.use.stage();
  const tourRun = useInChatOnboardingStore.use.tourRun();
  const finishTour = useInChatOnboardingStore.use.finishTour();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { components, traits } = useAssistantAvatar(assistantId);

  const tourRef = useRef<AvatarTourHandle | null>(null);
  /** True once Skip was pressed this run — tells the done handler to emit
   *  `tour_skipped` (already sent at click time) instead of completed. */
  const skippedRef = useRef(false);
  /** The stop the tour currently sits in; null while it's mid-transition. */
  const [narrationStep, setNarrationStep] = useState<TourStep | null>(null);
  /** Latches on first landing so the chat doesn't flash back between stops. */
  const [takeover, setTakeover] = useState(false);
  const [progress, setProgress] = useState<TourProgress | null>(null);

  const accent =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

  const handleStepChange = useCallback((step: TourStep | null) => {
    setNarrationStep(step);
    if (step) {
      setTakeover(true);
    }
  }, []);

  const handleTourDone = useCallback(() => {
    // Skip's own event was emitted at click time; a natural end past the
    // last beat is a completion.
    if (!skippedRef.current) {
      emitInChatTourCompleted();
    }
    skippedRef.current = false;
    setNarrationStep(null);
    setTakeover(false);
    setProgress(null);
    finishTour();
  }, [finishTour]);

  // Leaving the tour stage by any path (panel buttons, exit) lifts the
  // narration takeover.
  useEffect(() => {
    if (stage !== "tour") {
      setNarrationStep(null);
      setTakeover(false);
      setProgress(null);
      skippedRef.current = false;
    }
  }, [stage]);

  if (!prototypeActive) {
    return null;
  }

  const onIntroBeat = progress?.index === 0;
  /** Contrast tone over the intro's avatar-colored full-page flood. */
  const introFg = accent ? contrastForeground(accent) : "var(--content-strong)";

  const skipButton = (
    <Button
      variant="ghost"
      onClick={() => {
        skippedRef.current = true;
        emitInChatTourSkipped(progress?.index ?? 0, progress?.count ?? 0);
        tourRef.current?.skip();
      }}
      // Contrast-toned over the intro's avatar-colored flood.
      style={{ color: introFg }}
    >
      Skip tour
    </Button>
  );

  // The intro gets the theme's primary CTA with its Skip right beneath —
  // one cluster, typed into place under the headline. The walk's beats get
  // just an outlined Next; skipping is an intro-only affordance.
  const navigationControls = progress ? (
    onIntroBeat ? (
      <div className="flex flex-col items-center gap-6">
        {/* Mirrors research onboarding's Continue button (introduction
            screen) so the hand-off reads as one flow. */}
        <Button
          variant="primary"
          size="regular"
          rightIcon={<ArrowRight size={16} />}
          className="h-11 w-[234px] text-base"
          onClick={() => tourRef.current?.next()}
        >
          Show me around
        </Button>
        {skipButton}
      </div>
    ) : (
      <Button
        variant="outlined"
        rightIcon={<ArrowRight size={16} />}
        onClick={() => tourRef.current?.next()}
      >
        Next
      </Button>
    )
  ) : null;

  return (
    <>
      {/* While the tour runs, a transparent capture layer blocks every
          interaction with the app underneath (sidebar, composer, header).
          The narration takeover renders above it so the tour's own controls
          stay clickable; the dev panel (z-90) stays usable too. */}
      {stage === "tour"
        ? createPortal(
            <div aria-hidden className="fixed inset-0 z-[60] cursor-default" />,
            document.body,
          )
        : null}
      <AvatarTour
        key={tourRun}
        ref={tourRef}
        assistantId={assistantId}
        active={stage === "tour"}
        onStepChange={handleStepChange}
        onProgressChange={setProgress}
        onDone={handleTourDone}
      />
      {takeover ? (
        <TourOverlay
          assistantId={assistantId}
          step={narrationStep}
          onIntroBeat={onIntroBeat}
          controls={navigationControls}
        />
      ) : null}
    </>
  );
}
