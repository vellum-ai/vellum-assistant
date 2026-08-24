/**
 * The mobile drawer's painted surface (Figma 7842-83305).
 *
 * The sheet covers the chat rather than sitting beside it and paints a fully
 * opaque ground, so the page behind never bleeds through the navigation
 * column.
 *
 * Exported rather than written at the call site because two places draw it:
 * `chat-layout` mounts the real drawer, and the side-menu story mounts one
 * over a stand-in chat so the surface can be reviewed. A story holding
 * its own copy of the value can drift from the runtime surface and keep a
 * visual review green while showing a presentation nobody receives.
 */
export const DRAWER_SURFACE_BACKGROUND = "var(--surface-base)";
