import { ChevronLeft, ChevronRight } from "lucide-react";
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
import { PrototypeStagePanel } from "./prototype-stage-panel";
import { TourNarration } from "./tour-narration";
import { type TourStep } from "./tour-steps";

interface MainAreaRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Viewport rect of the layout's main content area (the chat surface the
 *  narration takes over), or null before layout. */
function measureMainArea(): MainAreaRect | null {
  const el = document.querySelector<HTMLElement>("main");
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * SPIKE — orchestrator for the in-chat onboarding UI prototype, mounted
 * alongside `ChatLayout` so it runs over the REAL conversation UI.
 *
 * The prototype has two stages, driven by the floating panel (bottom right)
 * so the animation work is testable on demand:
 *
 *   1. **Focused chat** — `ChatLayout` hides the sidebar and the header's
 *      controls (it reads the store's focus flag), leaving the real chat —
 *      transcript, avatar under the latest assistant message, full composer
 *      with attachments — as a chat-only takeover.
 *   2. **Reveal + tour** — {@link AvatarTour} walks the left nav beat by
 *      beat while each stop's line typewrites over the main chat area. The
 *      takeover latches on the first landing so the chat doesn't flash back
 *      between stops, and lifts when the tour finishes. This controller
 *      renders the tour's chrome below the typewriter text: back/next
 *      chevrons, the step-dot counter, and Skip tour.
 */
export function InChatOnboardingController() {
  const prototypeActive = useInChatOnboardingStore.use.prototypeActive();
  const stage = useInChatOnboardingStore.use.stage();
  const tourRun = useInChatOnboardingStore.use.tourRun();
  const finishTour = useInChatOnboardingStore.use.finishTour();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { components, traits } = useAssistantAvatar(assistantId);

  const tourRef = useRef<AvatarTourHandle | null>(null);
  /** The stop the tour currently sits in; null while it's mid-transition. */
  const [narrationStep, setNarrationStep] = useState<TourStep | null>(null);
  /** Latches on first landing so the chat doesn't flash back between stops. */
  const [takeover, setTakeover] = useState(false);
  const [mainRect, setMainRect] = useState<MainAreaRect | null>(null);
  const [progress, setProgress] = useState<TourProgress | null>(null);

  const accent =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

  const handleStepChange = useCallback((step: TourStep | null) => {
    setNarrationStep(step);
    if (step) {
      setMainRect((prev) => prev ?? measureMainArea());
      setTakeover(true);
    }
  }, []);

  const handleTourDone = useCallback(() => {
    setNarrationStep(null);
    setTakeover(false);
    setMainRect(null);
    setProgress(null);
    finishTour();
  }, [finishTour]);

  // Leaving the tour stage by any path (panel buttons, exit) lifts the
  // narration takeover.
  useEffect(() => {
    if (stage !== "tour") {
      setNarrationStep(null);
      setTakeover(false);
      setMainRect(null);
      setProgress(null);
    }
  }, [stage]);

  // Keep the takeover pinned to the main area as it moves — the sidebar
  // bounces in mid-tour and reflows the main column, not just on window
  // resizes.
  useEffect(() => {
    if (!takeover) {
      return;
    }
    const el = document.querySelector<HTMLElement>("main");
    const update = () => {
      setMainRect(measureMainArea());
    };
    window.addEventListener("resize", update);
    let observer: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(el);
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [takeover]);

  if (!prototypeActive) {
    return null;
  }

  const onIntroBeat = progress?.index === 0;
  /** Contrast tone over the intro's avatar-colored full-page flood. */
  const introFg = accent ? contrastForeground(accent) : "var(--content-strong)";

  const skipButton = (
    <button
      type="button"
      className={`text-label-small-default cursor-pointer rounded px-1.5 py-0.5 transition-[background-color,opacity] ${
        onIntroBeat ? "opacity-75 hover:opacity-100" : "hover:bg-[var(--surface-hover)]"
      }`}
      style={{ color: onIntroBeat ? introFg : "var(--content-tertiary)" }}
      onClick={() => tourRef.current?.skip()}
    >
      Skip tour
    </button>
  );

  // The intro gets a labeled CTA inverted against the flooded page (no
  // anonymous chevron, no disabled back button, no dots); the walk's beats
  // get the symmetric chevrons with the step counter.
  const navigationControls = progress ? (
    onIntroBeat ? (
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          className="text-body-medium-default cursor-pointer rounded-full px-6 py-2.5 shadow-[var(--shadow-lg)] transition-[transform,filter] hover:brightness-95 active:scale-[0.98]"
          style={{
            background: introFg,
            color: accent ?? "var(--content-strong)",
          }}
          onClick={() => tourRef.current?.next()}
        >
          Show me around →
        </button>
        {skipButton}
      </div>
    ) : (
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="ghost"
            iconOnly={<ChevronLeft />}
            aria-label="Previous tour step"
            className="rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-[var(--shadow-lg)]"
            onClick={() => tourRef.current?.back()}
          />
          <Button
            variant="ghost"
            iconOnly={<ChevronRight />}
            aria-label="Next tour step"
            className="rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-[var(--shadow-lg)]"
            onClick={() => tourRef.current?.next()}
          />
        </div>
        <div className="flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: progress.count }, (_, i) => (
            <span
              key={i}
              className="size-1.5 rounded-full transition-colors duration-300"
              style={{
                background:
                  i === progress.index
                    ? (accent ?? "var(--content-strong)")
                    : "var(--border-base)",
              }}
            />
          ))}
        </div>
        {skipButton}
      </div>
    )
  ) : null;

  return (
    <>
      <PrototypeStagePanel />
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
      {takeover && mainRect
        ? createPortal(
            <div
              className="fixed z-[62] flex"
              style={{
                left: mainRect.left,
                top: mainRect.top,
                width: mainRect.width,
                height: mainRect.height,
                // The intro's full-page flood (portaled underneath) provides
                // the backdrop; other beats blank the chat area themselves.
                background: onIntroBeat
                  ? "transparent"
                  : "var(--surface-base)",
                transition: "background-color 300ms ease",
              }}
            >
              <TourNarration
                assistantId={assistantId}
                step={narrationStep}
                variant={onIntroBeat ? "intro" : "top"}
                controls={navigationControls}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
