import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { supportsLiveVoice } from "@/lib/backwards-compat/use-supports-live-voice";
import { whenAssistantVersionKnown } from "@/lib/backwards-compat/utils";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

import { TourButtonLanding } from "./tour-button-landing";
import { TourMenuFlood } from "./tour-menu-flood";
import {
  FLOOD_EXIT_MS,
  TourNavFlood,
  type TourEyeArt,
  type TourFloodPhase,
  type TourTargetRect,
} from "./tour-nav-flood";
import {
  TOUR_COMPOSER,
  TOUR_INTRO,
  TOUR_SIDEBAR,
  TOUR_STEPS,
  TOUR_VOICE,
  type TourStep,
} from "./tour-steps";

/** Beat after the tour starts before the intro line begins typing. */
const TOUR_LEAD_IN_MS = 350;
/** Head start the sidebar's bounce-in gets before the takeover flood pours,
 *  so the two read as one arrival. */
const SIDEBAR_BOUNCE_LEAD_MS = 300;
/** Settle time for the chrome hiding again when stepping back to the intro. */
const CHROME_HIDE_SETTLE_MS = 300;
/** The sidebar beat's eyes span 125% of the panel width — centered, so 10%
 *  of the art clips off past each side edge. */
const MENU_EYES_WIDTH_FRACTION = 1.25;
/** ...and sit low enough that 20% of the art clips below the bottom edge. */
const MENU_EYES_BOTTOM_CUT_FRACTION = 0.2;
/** The composer finale's eyes over its wide, short panel — modest span. */
const COMPOSER_EYES_WIDTH_FRACTION = 0.2;
/** ...sunk low: nearly half the art clips below the input's bottom edge,
 *  so they peek over the rim rather than dominating the short panel. */
const COMPOSER_EYES_BOTTOM_CUT_FRACTION = 0.45;

/** One stop in the tour, in play order. */
type TourBeat =
  | { kind: "intro" }
  | { kind: "menu"; rect: TourTargetRect }
  | { kind: "row"; step: TourStep; rect: TourTargetRect; label: string }
  | { kind: "composer" }
  | { kind: "voice" };

interface LandedStop {
  step: TourStep;
  rect: TourTargetRect;
  label: string;
}

/** Chevron/skip navigation surface, driven by the controller's controls. */
export interface AvatarTourHandle {
  back: () => void;
  next: () => void;
  skip: () => void;
}

export interface TourProgress {
  index: number;
  count: number;
}

/** Row placement for a tour target, or null when the target isn't in the
 *  DOM (collapsed rail, mobile overlay). */
function measureTarget(
  id: string,
): { rect: TourTargetRect; label: string } | null {
  const el = document.querySelector<HTMLElement>(`[data-tour-id="${id}"]`);
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  return {
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    label: el.textContent?.trim() || id,
  };
}

/** Viewport rect of the whole side menu, or null when it isn't on screen.
 *  While the rail is still hidden (width 0, about to bounce in) its inner
 *  menu keeps its full layout width, so the final rect is predictable
 *  before the reveal transition runs. */
function measureMenuRect(): TourTargetRect | null {
  const el = document.querySelector<HTMLElement>("#chat-side-menu");
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  const innerWidth = el.firstElementChild?.getBoundingClientRect().width ?? 0;
  const width = Math.max(rect.width, innerWidth);
  if (width < 40 || rect.height === 0) {
    return null;
  }
  return {
    left: rect.left,
    top: rect.top,
    width,
    height: rect.height,
  };
}

/** Viewport rect of the chat composer, or null when none is rendered.
 *  Prefers the tour overlay's own scenery composer over the app's (hidden
 *  behind the backdrop). Measured at beat entry, not up front — the main
 *  column reflows when the sidebar reveals, so an early rect would land
 *  the flood off-target. */
function measureComposerRect(): TourTargetRect | null {
  const el =
    document.querySelector<HTMLElement>(
      '[data-tour-composer] [data-slot="chat-composer"]',
    ) ?? document.querySelector<HTMLElement>('[data-slot="chat-composer"]');
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/** Viewport rect of the composer's live-voice button, or null when it is not
 *  currently rendered. Prefers the tour overlay's scenery composer over the
 *  app's, and is measured at beat entry, for the same reasons as
 *  {@link measureComposerRect}.
 *
 *  A placement probe, not a capability check: the button leaves the DOM
 *  whenever the composer's action row is busy or holds sendable content, so
 *  null means "not on screen right now", never "this assistant serves no live
 *  voice". Whether the finale exists at all is decided by
 *  {@link supportsLiveVoice} in `start()`. */
function measureVoiceRect(): TourTargetRect | null {
  const el =
    document.querySelector<HTMLElement>(
      '[data-tour-composer] [data-tour-id="voice-mode"]',
    ) ?? document.querySelector<HTMLElement>('[data-tour-id="voice-mode"]');
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface AvatarTourProps {
  assistantId: string | null;
  /** Starts (or restarts, via a fresh `key`) the tour sequence. */
  active: boolean;
  /** Fires with each beat as it lands, and null as it moves on — drives the
   *  main-area narration takeover. */
  onStepChange: (step: TourStep | null) => void;
  /** Fires with the current beat position (null before the tour lands) so
   *  the controller can render the step counter and controls. */
  onProgressChange: (progress: TourProgress | null) => void;
  onDone: () => void;
  ref?: Ref<AvatarTourHandle>;
}

/**
 * The reveal stage of in-chat onboarding, told entirely through the
 * assistant's eyes surfacing into the chrome. The intro is a full-page
 * takeover: the whole viewport floods with the avatar's color, the opener
 * typed over it — then small eyes slide beneath the typed words (the
 * narration's own animation), bumping each word up as they pass.
 * Then the sidebar bounces in and the menu gets the same treatment at
 * panel scale, and the walk continues item by item — flood + eyes per row,
 * duck-under hops between rows — each line typewriting at the top of the
 * main area via {@link onStepChange}.
 *
 * Beats advance ONLY through the controller-rendered controls, wired to
 * this component's {@link AvatarTourHandle}. Every navigation plays the
 * current beat's exit animation before entering the target, guarded by an
 * epoch so rapid clicks supersede in-flight transitions cleanly. Stepping
 * past the last beat — or skipping — ends the tour.
 *
 * Targets are located by DOM anchors (`data-tour-id`, `#chat-side-menu`)
 * rather than imports. Beats whose anchor is missing are skipped.
 */
export function AvatarTour({
  assistantId,
  active,
  onStepChange,
  onProgressChange,
  onDone,
  ref,
}: AvatarTourProps) {
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);
  const setNavTourActive = useInChatOnboardingStore.use.setNavTourActive();
  const setTourSidebarRevealed =
    useInChatOnboardingStore.use.setTourSidebarRevealed();
  const [menuFlood, setMenuFlood] = useState<TourTargetRect | null>(null);
  const [menuPhase, setMenuPhase] = useState<TourFloodPhase>("enter");
  const [landed, setLanded] = useState<LandedStop | null>(null);
  const [floodPhase, setFloodPhase] = useState<TourFloodPhase>("enter");
  const [pageFlood, setPageFlood] = useState<TourTargetRect | null>(null);
  const [pagePhase, setPagePhase] = useState<TourFloodPhase>("enter");
  const [composerFlood, setComposerFlood] = useState<TourTargetRect | null>(
    null,
  );
  const [composerPhase, setComposerPhase] = useState<TourFloodPhase>("enter");
  const [buttonLanding, setButtonLanding] = useState<TourTargetRect | null>(
    null,
  );
  const [buttonPhase, setButtonPhase] = useState<TourFloodPhase>("enter");
  const [beatIndex, setBeatIndex] = useState(-1);
  const [beatCount, setBeatCount] = useState(0);

  const beatsRef = useRef<TourBeat[]>([]);
  /** Bumped by every navigation; in-flight sequences check it after each
   *  await and bail when superseded. */
  const epochRef = useRef(0);
  /** Which overlay is currently on screen, for the exit leg of a jump. */
  const visualRef = useRef<
    "none" | "page" | "menu" | "row" | "composer" | "voice"
  >("none");
  const activeRef = useRef(false);
  /** Read by the beat-building effect, which must not re-run (and so restart
   *  the tour from its intro) when the bound assistant changes. A mid-tour
   *  swap is handled at the finale's entry, which ends the tour when the
   *  button it lands on is gone. */
  const assistantIdRef = useRef(assistantId);
  useEffect(() => {
    assistantIdRef.current = assistantId;
  }, [assistantId]);

  const accent =
    (components &&
      traits &&
      components.colors.find((c) => c.id === traits.color)?.hex) ||
    null;

  const eye = useMemo<TourEyeArt | null>(() => {
    if (!components || !traits) {
      return null;
    }
    const def = components.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      id: def.id,
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits]);

  // The sidebar's own avatar treatment (colored assistant row, resting eyes,
  // the New Chat visit flood) stays fully suppressed for the tour's duration
  // — the tour supplies the color and eyes on those rows itself.
  useEffect(() => {
    if (!active) {
      return;
    }
    setNavTourActive(true);
    return () => setNavTourActive(false);
  }, [active, setNavTourActive]);

  useEffect(() => {
    onProgressChange(
      active && beatIndex >= 0 ? { index: beatIndex, count: beatCount } : null,
    );
  }, [active, beatIndex, beatCount, onProgressChange]);

  /** Exit whatever's on screen, then enter beat `index` and stay there —
   *  advancement is chevron-driven only. `index === beats.length` exits and
   *  ends the tour. */
  const goTo = useCallback(
    async (index: number) => {
      const epoch = ++epochRef.current;
      const superseded = () => epochRef.current !== epoch || !activeRef.current;
      const beats = beatsRef.current;
      if (index < 0) {
        return;
      }

      // Exit the current visual first so every navigation — scripted or
      // manual — plays the same leaving animation.
      const visual = visualRef.current;
      onStepChange(null);
      if (visual === "page") {
        setPagePhase("exit");
        await sleep(FLOOD_EXIT_MS);
        if (superseded()) {
          return;
        }
        setPageFlood(null);
      } else if (visual === "menu") {
        setMenuPhase("exit");
        await sleep(FLOOD_EXIT_MS);
        if (superseded()) {
          return;
        }
        setMenuFlood(null);
      } else if (visual === "row") {
        setFloodPhase("exit");
        await sleep(FLOOD_EXIT_MS);
        if (superseded()) {
          return;
        }
        setLanded(null);
      } else if (visual === "composer") {
        setComposerPhase("exit");
        await sleep(FLOOD_EXIT_MS);
        if (superseded()) {
          return;
        }
        setComposerFlood(null);
      } else if (visual === "voice") {
        setButtonPhase("exit");
        await sleep(FLOOD_EXIT_MS);
        if (superseded()) {
          return;
        }
        setButtonLanding(null);
      }
      visualRef.current = "none";

      if (index >= beats.length) {
        onDone();
        return;
      }
      setBeatIndex(index);
      const beat = beats[index];

      if (beat.kind === "intro") {
        // The intro plays over hidden chrome — stepping back re-hides it.
        setTourSidebarRevealed(false);
        await sleep(CHROME_HIDE_SETTLE_MS);
        if (superseded()) {
          return;
        }
        // Full-page takeover: the whole viewport is the avatar's panel.
        setPageFlood({
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        });
        setPagePhase("enter");
        visualRef.current = "page";
        onStepChange(TOUR_INTRO);
      } else if (beat.kind === "menu") {
        setTourSidebarRevealed(true);
        await sleep(SIDEBAR_BOUNCE_LEAD_MS);
        if (superseded()) {
          return;
        }
        setMenuFlood(beat.rect);
        setMenuPhase("enter");
        visualRef.current = "menu";
        onStepChange(TOUR_SIDEBAR);
      } else if (beat.kind === "composer") {
        setTourSidebarRevealed(true);
        await sleep(SIDEBAR_BOUNCE_LEAD_MS);
        if (superseded()) {
          return;
        }
        const rect = measureComposerRect();
        if (!rect) {
          // Composer gone (layout changed mid-tour) — end past the finale.
          onDone();
          return;
        }
        setComposerFlood(rect);
        setComposerPhase("enter");
        visualRef.current = "composer";
        onStepChange(TOUR_COMPOSER);
      } else if (beat.kind === "voice") {
        setTourSidebarRevealed(true);
        const rect = measureVoiceRect();
        if (!rect) {
          // Voice button gone (an assistant swap mid-tour dropped live-voice
          // support), so end past the finale.
          onDone();
          return;
        }
        setButtonLanding(rect);
        setButtonPhase("enter");
        visualRef.current = "voice";
        onStepChange(TOUR_VOICE);
      } else {
        setTourSidebarRevealed(true);
        setLanded({ step: beat.step, rect: beat.rect, label: beat.label });
        setFloodPhase("enter");
        visualRef.current = "row";
        onStepChange(beat.step);
      }
    },
    [onStepChange, onDone, setTourSidebarRevealed],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    activeRef.current = true;

    const start = async () => {
      setLanded(null);
      setMenuFlood(null);
      setPageFlood(null);
      setComposerFlood(null);
      setBeatIndex(-1);
      setBeatCount(0);
      visualRef.current = "none";
      // The lead-in doubles as the hydration window for the finale's
      // capability gate below, so it reads a resolved version rather than the
      // conservative `false`-on-unknown default. Bounded by the lead-in
      // itself: the controller paints its input-blocking capture layer the
      // moment the tour stage opens, so any wait past this point is an inert
      // chat the user cannot touch. A hydrated version resolves
      // synchronously, which is the common case on the onboarding hand-off.
      await Promise.all([
        sleep(TOUR_LEAD_IN_MS),
        whenAssistantVersionKnown(TOUR_LEAD_IN_MS),
      ]);
      if (!activeRef.current) {
        return;
      }
      // Measure every beat up front — target layout is stable even while
      // the rail is hidden (clipped, not collapsed).
      const beats: TourBeat[] = [{ kind: "intro" }];
      const menu = measureMenuRect();
      if (menu) {
        beats.push({ kind: "menu", rect: menu });
      }
      for (const step of TOUR_STEPS) {
        const placement = measureTarget(step.id);
        if (placement) {
          beats.push({ kind: "row", step, ...placement });
        }
      }
      // The chat beat, whose composer rect is measured at entry, since the
      // sidebar reveal reflows the main column under it.
      if (measureComposerRect()) {
        beats.push({ kind: "composer" });
      }
      // The finale, on the voice button inside that composer. Gated on the
      // assistant's live-voice capability rather than the button's presence,
      // because the beat list is frozen here while the composer is mid
      // auto-greet: a busy composer swaps its whole action row, voice button
      // included, for the stop button, so a DOM probe at this instant reads
      // as "no live voice" for an assistant that serves it. The rect is
      // measured at beat entry, which is what places the avatar.
      if (supportsLiveVoice(assistantIdRef.current)) {
        beats.push({ kind: "voice" });
      }
      beatsRef.current = beats;
      setBeatCount(beats.length);
      void goTo(0);
    };

    void start();
    return () => {
      activeRef.current = false;
      epochRef.current += 1;
    };
  }, [active, goTo]);

  const handleBack = useCallback(() => {
    if (beatIndex > 0) {
      void goTo(beatIndex - 1);
    }
  }, [beatIndex, goTo]);

  const handleNext = useCallback(() => {
    void goTo(beatIndex + 1);
  }, [beatIndex, goTo]);

  const handleSkip = useCallback(() => {
    void goTo(beatsRef.current.length);
  }, [goTo]);

  useImperativeHandle(
    ref,
    () => ({ back: handleBack, next: handleNext, skip: handleSkip }),
    [handleBack, handleNext, handleSkip],
  );

  return createPortal(
    <>
      {pageFlood ? (
        <TourMenuFlood
          rect={pageFlood}
          hex={accent}
          // The intro's eyes live in the narration's headline (they slide
          // under the typed words), not in the flood.
          eye={null}
          phase={pagePhase}
          rounded={false}
          // Under the narration overlay (z-62) so the intro text and CTA
          // read on top of the flooded color.
          zClassName="z-[61]"
        />
      ) : null}
      {menuFlood ? (
        <TourMenuFlood
          rect={menuFlood}
          hex={accent}
          eye={eye}
          phase={menuPhase}
          eyesWidthFraction={MENU_EYES_WIDTH_FRACTION}
          eyesBottomCutFraction={MENU_EYES_BOTTOM_CUT_FRACTION}
        />
      ) : null}
      {landed ? (
        <TourNavFlood
          rect={landed.rect}
          label={landed.label}
          hex={accent}
          eye={eye}
          phase={floodPhase}
        />
      ) : null}
      {composerFlood ? (
        <TourMenuFlood
          rect={composerFlood}
          hex={accent}
          eye={eye}
          phase={composerPhase}
          eyesWidthFraction={COMPOSER_EYES_WIDTH_FRACTION}
          eyesBottomCutFraction={COMPOSER_EYES_BOTTOM_CUT_FRACTION}
        />
      ) : null}
      {buttonLanding ? (
        <TourButtonLanding
          rect={buttonLanding}
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          phase={buttonPhase}
        />
      ) : null}
    </>,
    document.body,
  );
}
