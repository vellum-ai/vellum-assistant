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
  SLOT_ROTATIONS,
} from "@/domains/onboarding/components/onboarding-character-stage";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

// Per-slot depth pass, indexed by edge slot (0–10). A slight size variation so
// the cast isn't a uniform ring, and reduced opacity on a few so some sit back
// for depth. Deterministic by slot — never jumps between renders; slots past
// the table fall back to full size / full opacity.
const SLOT_SCALE = [1.12, 0.85, 1.0, 0.9, 1.14, 0.82, 1.06, 0.92, 1.1, 0.88, 1.0];
const SLOT_OPACITY = [1, 0.5, 1, 0.7, 1, 0.55, 0.85, 0.65, 1, 0.75, 0.6];

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
        // Depth pass: scale around the slot centre and dim a few so the ring
        // reads with depth instead of a flat, uniform border.
        const scale = SLOT_SCALE[slot] ?? 1;
        const avatarSize = size * scale;
        const opacity = SLOT_OPACITY[slot] ?? 1;
        return (
          <div
            key={i}
            className="absolute"
            style={{
              left: p.x - avatarSize / 2,
              top: p.y - avatarSize / 2,
              width: avatarSize,
              height: avatarSize,
              opacity,
              animation: reduce
                ? undefined
                : `character-pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${0.1 + i * 0.05}s both`,
            }}
          >
            <div style={{ transform: `rotate(${rotation}deg)` }}>
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
