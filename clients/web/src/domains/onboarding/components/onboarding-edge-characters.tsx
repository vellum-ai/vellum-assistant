/**
 * The onboarding cast on the first screen: the shared pool of characters
 * scattered, cut off, around the edges.
 *
 * SPIKE — research-onboarding flow.
 *
 * Uses the same edge slots and rotations as the picker step
 * (`OnboardingCharacterStage`) so the arrangement matches between the two
 * screens, but adds a per-slot depth pass — a slight size variation and reduced
 * opacity on a few of the cast — so the first screen's ring reads with depth
 * rather than a flat, uniform border. Pool index 0 is the picker's centered
 * avatar, so it's omitted here (the form sits in the center); indices 1–9 fill
 * edge slots 0–8.
 *
 * Decorative: `aria-hidden`, `pointer-events-none`, reduced-motion safe.
 */

import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import {
  edgeSize,
  edgeSlots,
  slotDepthOpacity,
  slotDepthScale,
  slotDepthZ,
  SLOT_ROTATIONS,
} from "@/domains/onboarding/components/onboarding-character-stage";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

function useViewport() {
  const [size, setSize] = useState(() => ({
    w: typeof window === "undefined" ? 1280 : window.innerWidth,
    h: typeof window === "undefined" ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

export function OnboardingEdgeCharacters() {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const ensureGenerated = useOnboardingAvatarPoolStore.use.ensureGenerated();
  const reduce = useReducedMotion();
  const { w, h } = useViewport();

  useEffect(() => {
    if (components) ensureGenerated(components);
  }, [components, ensureGenerated]);

  const size = edgeSize(w, h);
  const positions = useMemo(() => edgeSlots(w, h, size / 2), [w, h, size]);

  // On mobile the form fills the width, so the side avatars sit right behind it
  // and feel crowded. Keep only the top edge (slots 0–3) and bottom corners
  // (5, 6), dropping the side slots 4 (right-lower), 7 (left-mid), 8 (right-
  // upper) and the desktop-only bottom-center slots 9/10.
  const isMobile = w < 640;
  const HIDDEN_ON_MOBILE = new Set([4, 7, 8, 9, 10]);

  if (!components || characters.length === 0) return null;

  // Indices 1–9 sit at edge slots 0–8 (same mapping as the picker); index 0 is
  // the picker's centered avatar and isn't scattered here.
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      {characters.map((traits, i) => {
        if (i === 0) return null;
        const slot = i - 1;
        if (isMobile && HIDDEN_ON_MOBILE.has(slot)) return null;
        const p = positions[slot];
        if (!p) return null;
        const rotation = SLOT_ROTATIONS[slot % SLOT_ROTATIONS.length] ?? 0;
        // Depth pass: a single per-slot layer (shared with the picker screen)
        // drives size, opacity, and stacking so the further-back avatars shrink,
        // fade, AND sit behind the front ones.
        const avatarSize = size * slotDepthScale(slot);
        const opacity = slotDepthOpacity(slot);
        const zIndex = slotDepthZ(slot);
        return (
          <div
            key={i}
            className="absolute"
            style={{
              left: p.x - avatarSize / 2,
              top: p.y - avatarSize / 2,
              width: avatarSize,
              height: avatarSize,
              zIndex,
              animation: reduce
                ? undefined
                : `character-pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${0.1 + i * 0.05}s both`,
            }}
          >
            {/* Opacity sits on this inner wrapper, not the animated parent: the
                `character-pop-in` keyframes animate opacity 0→1 with `both`
                fill, which would otherwise override an inline opacity on the
                same element and pin every avatar to full opacity. */}
            <div style={{ opacity, transform: `rotate(${rotation}deg)` }}>
              <AnimatedAvatar
                components={components}
                traits={traits}
                size={avatarSize}
                breathe={false}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
