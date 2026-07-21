/**
 * Shared "stage size" for the research-onboarding decorative layers.
 *
 * SPIKE — research-onboarding flow.
 *
 * The decorative layers (the avatar character stage, the edge/peeking crowd, the
 * bottom eyes, the coin arc) and the foreground content must share one
 * coordinate space. Each onboarding screen measures its own `relative h-full`
 * container — the dvh-sized, safe-area-padded onboarding box (see
 * `root-layout.tsx`) — via `useElementSize` (from `@/hooks/use-element-size`)
 * and publishes that size here. The decorative layers read it with
 * `useOnboardingStageSize()` and position themselves `absolute` inside that
 * same container, so they line up with the `%`-positioned foreground
 * regardless of mobile viewport quirks. When no provider is present the hook
 * falls back to the window size so standalone use never breaks.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { windowSize, type StageSize } from "@/hooks/use-element-size";

export { useElementSize } from "@/hooks/use-element-size";
export type { ElementSize, StageSize } from "@/hooks/use-element-size";

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
