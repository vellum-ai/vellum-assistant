/**
 * The mobile drawer's painted surface (Figma 7842-83305).
 *
 * The sheet covers the chat rather than sitting beside it, so it thins toward
 * the chat edge and leaves the page legible through its right side while the
 * column of navigation rests on solid ground.
 *
 * Exported rather than written at the call site because two places draw it:
 * `chat-layout` mounts the real drawer, and the side-menu story mounts one
 * over a stand-in chat so the translucency can be reviewed. A story holding
 * its own copy of the value can drift from the runtime surface and keep a
 * visual review green while showing a presentation nobody receives.
 */
export const DRAWER_SURFACE_BACKGROUND =
  "linear-gradient(to right, var(--surface-base), color-mix(in srgb, var(--surface-base) 90%, transparent))";
