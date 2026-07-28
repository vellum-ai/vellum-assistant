/**
 * Shared centered content container for the onboarding step screens.
 *
 * SPIKE — research-onboarding flow.
 *
 * Keeps the heading + Continue at a consistent height and spacing across every
 * step. Width is left to each step (append a `max-w-*`), since the copy differs.
 */
export const ONBOARDING_STEP_CONTENT =
  "absolute left-1/2 top-[30%] z-10 flex w-full -translate-x-1/2 flex-col items-center gap-8 px-6 text-center";

/**
 * iOS Safari / WKWebView auto-zooms the viewport when a focused form control
 * renders below 16px. The onboarding text inputs inherit the design-library
 * 14px body size (`text-body-medium-lighter`), so append this to bump them to
 * 16px on touch phones only — desktop and Electron keep the 14px design size
 * via the `touch-mobile` guard (`width < 48rem` and `pointer: coarse`).
 * See LUM-2597.
 */
export const MOBILE_INPUT_NO_ZOOM = "touch-mobile:text-[16px]";
