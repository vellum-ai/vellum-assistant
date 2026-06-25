/**
 * Shared "stage size" for the research-onboarding decorative layers.
 *
 * SPIKE — research-onboarding flow.
 *
 * The decorative layers (the avatar character stage, the edge/peeking crowd, the
 * bottom eyes, the coin arc) used to measure `window.innerWidth/innerHeight` and
 * position themselves `fixed`. On mobile that disagrees with the foreground
 * content, which lives in the dvh-sized, safe-area-padded onboarding container
 * (see `root-layout.tsx`): on iOS a `position: fixed` layer resolves against the
 * full layout viewport while the container is shorter, so the centered avatar
 * sat above the arrows, the edge cast didn't sit flush, and the page scrolled.
 *
 * Instead each onboarding screen measures its own `relative h-full` container
 * (via `useElementSize`) and publishes that size here. The decorative layers
 * read it with `useOnboardingStageSize()` and position themselves `absolute`
 * inside that same container, so every layer shares one coordinate space. When
 * no provider is present the hook falls back to the window size so standalone
 * use never breaks.
 */

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

export interface StageSize {
  w: number;
  h: number;
}

const FALLBACK: StageSize = { w: 1280, h: 800 };

function windowSize(): StageSize {
  if (typeof window === "undefined") return FALLBACK;
  return { w: window.innerWidth, h: window.innerHeight };
}

export interface ElementSize {
  /** Callback ref — attach to the element to measure (`<div ref={ref}>`). */
  ref: (el: HTMLElement | null) => void;
  size: StageSize;
}

/**
 * Measure an element's box, kept live via `ResizeObserver`. Uses a callback ref
 * (stored in state) so it re-measures whenever the element mounts/unmounts —
 * robust to containers that appear after the first render (e.g. a step that's
 * conditionally rendered). Returns the window size until the element mounts.
 */
export function useElementSize(): ElementSize {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<StageSize>(() => windowSize());

  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return { ref: setEl, size };
}

const OnboardingStageSizeContext = createContext<StageSize | null>(null);

export function OnboardingStageSizeProvider({
  size,
  children,
}: {
  size: StageSize;
  children: ReactNode;
}) {
  return (
    <OnboardingStageSizeContext.Provider value={size}>
      {children}
    </OnboardingStageSizeContext.Provider>
  );
}

/**
 * The size of the onboarding stage container. Falls back to the window size
 * (kept live on resize) when used outside a provider.
 */
export function useOnboardingStageSize(): StageSize {
  const ctx = useContext(OnboardingStageSizeContext);
  const [fallback, setFallback] = useState<StageSize>(() => windowSize());
  useEffect(() => {
    if (ctx) return; // a provider supplies the size; no need to track the window
    const onResize = () => setFallback(windowSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [ctx]);
  return ctx ?? fallback;
}
