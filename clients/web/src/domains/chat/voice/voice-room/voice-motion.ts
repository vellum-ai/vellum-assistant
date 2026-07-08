/**
 * Shared motion-spring constants for the live-voice room surfaces.
 *
 * Kept here — inside the voice domain — so `voice-avatar.tsx` and
 * `voice-room.tsx` declare each spring once instead of hand-copying it, without
 * reaching into the constellation domain for its `NODE_SPRING`. The two springs
 * are intentionally different tunings, so both live here as named exports.
 */

/**
 * Avatar enter/scale spring replayed on each discrete visual change (see
 * `voice-avatar.tsx`). Value-identical to the app's constellation `NODE_SPRING`
 * overshoot convention.
 */
export const AVATAR_VISUAL_SPRING = {
  type: "spring" as const,
  stiffness: 180,
  damping: 20,
};

/**
 * Room entry spring (see `voice-room.tsx`): the avatar rises from a smaller,
 * lower offset to center with a slightly stiffer overshoot than the per-visual
 * spring.
 */
export const AVATAR_ENTER_SPRING = {
  type: "spring" as const,
  stiffness: 200,
  damping: 18,
};
