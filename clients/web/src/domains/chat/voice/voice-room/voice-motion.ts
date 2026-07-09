/**
 * Shared motion-spring constants for the live-voice room surfaces.
 *
 * Kept here — inside the voice domain — so the room surface declares the spring
 * once instead of hand-copying it, without reaching into the constellation
 * domain for its `NODE_SPRING`.
 */

/**
 * Room entry spring (see `voice-room.tsx`): the avatar rises from a smaller,
 * lower offset to center with a slight overshoot. Fires once when the room
 * opens; per-state expression is the avatar's own CSS loop, not a spring.
 */
export const AVATAR_ENTER_SPRING = {
  type: "spring" as const,
  stiffness: 200,
  damping: 18,
};
