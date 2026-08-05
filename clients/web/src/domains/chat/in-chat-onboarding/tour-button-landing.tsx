import { motion } from "motion/react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

import {
  FLOOD_EXIT_MS,
  type TourFloodPhase,
  type TourTargetRect,
} from "./tour-nav-flood";

/** The landed avatar's diameter, as a multiple of the target's short side. */
const AVATAR_OVERSIZE = 1.5;
/** How far the avatar settles into the control's top edge, as a fraction of
 *  its own diameter. Enough that it reads as planted on the button rather
 *  than hovering above it. */
const PERCH_SINK = 0.12;
/** Where the avatar falls from, as a multiple of its own diameter. */
const DROP_HEIGHT = 1.1;

interface TourButtonLandingProps {
  rect: TourTargetRect;
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  /** `enter`: the avatar drops onto the control's top edge. `exit`: it lifts
   *  back off the way it came. */
  phase: TourFloodPhase;
}

/**
 * The "avatar lands on this control" treatment: the avatar drops from above
 * and perches on the target's top edge, leaving the control itself untouched.
 *
 * Distinct from `TourNavFlood`, which floods a row with the avatar's color and
 * surfaces the eyes through its bottom edge. That one is tuned for the
 * sidebar's wide rows, where the eyes have room to rest in their own slot
 * beside the row's text. A single small control gives them neither, and
 * coloring it would bury the very affordance the beat is pointing at, so the
 * whole character lands on top of it instead.
 */
export function TourButtonLanding({
  rect,
  components,
  traits,
  customImageUrl,
  phase,
}: TourButtonLandingProps) {
  const size = Math.min(rect.width, rect.height) * AVATAR_OVERSIZE;
  const dropY = -size * DROP_HEIGHT;
  const entering = phase === "enter";

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed z-[65]"
      style={{
        left: rect.left + rect.width / 2 - size / 2,
        // Rests on the control's top edge rather than over its face, so the
        // button stays exactly as the user will meet it a moment later.
        top: rect.top - size + size * PERCH_SINK,
        width: size,
        height: size,
      }}
      initial={{ y: dropY, opacity: 0 }}
      animate={entering ? { y: 0, opacity: 1 } : { y: dropY, opacity: 0 }}
      transition={
        entering
          ? // Lands with a little overshoot, so it reads as arriving rather
            // than fading in on the spot.
            { type: "spring", stiffness: 420, damping: 18, delay: 0.1 }
          : { duration: FLOOD_EXIT_MS / 1000, ease: "easeIn" }
      }
    >
      {/* Sized to the wrapper, which is centered on the control's width and
          resting on its top edge. The avatar plays its own mount spring on
          top of the drop, so the landing carries its usual pop. */}
      <ChatAvatar
        components={components}
        traits={traits}
        customImageUrl={customImageUrl}
        size={size}
      />
    </motion.div>
  );
}
