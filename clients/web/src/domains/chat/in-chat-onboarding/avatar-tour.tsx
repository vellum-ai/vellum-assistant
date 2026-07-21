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
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

import { TourMenuFlood } from "./tour-menu-flood";
import {
  FLOOD_EXIT_MS,
  TourNavFlood,
  type TourEyeArt,
  type TourFloodPhase,
  type TourTargetRect,
} from "./tour-nav-flood";
import {
  TOUR_INTRO,
  TOUR_SIDEBAR,
  TOUR_STEPS,
  type TourStep,
} from "./tour-steps";

/** Beat after the tour starts before the intro line begins typing. */
const TOUR_LEAD_IN_MS = 350;
/** Head start the sidebar's bounce-in gets before the takeover flood pours,
 *  so the two read as one arrival. */
const SIDEBAR_BOUNCE_LEAD_MS = 300;
/** Settle time for the chrome hiding again when stepping back to the intro. */
const CHROME_HIDE_SETTLE_MS = 300;
/** The intro's full-page eyes over a nav row's resting size — the whole
 *  screen is the avatar's panel for this beat. */
const PAGE_EYES_GROWTH = 8;
/** Where the intro eyes perch, as a fraction of the viewport's height. */
const PAGE_EYES_Y_FRACTION = 0.92;

/** One stop in the tour, in play order. */
type TourBeat =
  | { kind: "intro" }
  | { kind: "menu"; rect: TourTargetRect }
  | { kind: "row"; step: TourStep; rect: TourTargetRect; label: string };

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
 * takeover: the whole viewport floods with the avatar's color while giant
 * eyes bounce up through the bottom edge, the opener typed over the color.
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
  const { components, traits } = useAssistantAvatar(assistantId);
  const setNavTourActive = useInChatOnboardingStore.use.setNavTourActive();
  const setTourSidebarRevealed =
    useInChatOnboardingStore.use.setTourSidebarRevealed();
  const [menuFlood, setMenuFlood] = useState<TourTargetRect | null>(null);
  const [menuPhase, setMenuPhase] = useState<TourFloodPhase>("enter");
  const [landed, setLanded] = useState<LandedStop | null>(null);
  const [floodPhase, setFloodPhase] = useState<TourFloodPhase>("enter");
  const [pageFlood, setPageFlood] = useState<TourTargetRect | null>(null);
  const [pagePhase, setPagePhase] = useState<TourFloodPhase>("enter");
  const [beatIndex, setBeatIndex] = useState(-1);
  const [beatCount, setBeatCount] = useState(0);

  const beatsRef = useRef<TourBeat[]>([]);
  /** Bumped by every navigation; in-flight sequences check it after each
   *  await and bail when superseded. */
  const epochRef = useRef(0);
  /** Which overlay is currently on screen, for the exit leg of a jump. */
  const visualRef = useRef<"none" | "page" | "menu" | "row">("none");
  const activeRef = useRef(false);

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
      const superseded = () =>
        epochRef.current !== epoch || !activeRef.current;
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
      setBeatIndex(-1);
      setBeatCount(0);
      visualRef.current = "none";
      await sleep(TOUR_LEAD_IN_MS);
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
          eye={eye}
          phase={pagePhase}
          eyesGrowth={PAGE_EYES_GROWTH}
          eyesYFraction={PAGE_EYES_Y_FRACTION}
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
    </>,
    document.body,
  );
}
