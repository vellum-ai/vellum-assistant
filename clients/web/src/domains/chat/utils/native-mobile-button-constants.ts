/**
 * Strips the design library's touch-mobile pill fill from an icon-only ghost
 * Button inside Capacitor mobile shells, so the glyph floats bare.
 *
 * Both utilities sit outside media queries and apply on every native mobile
 * device. The `native-mobile:` prefix differs from `touch-mobile:`, so
 * tailwind-merge preserves the 40x40 touch target from the design library.
 */
export const NATIVE_MOBILE_BARE_ICON_BUTTON =
  "native-mobile:bg-transparent native-mobile:active:bg-transparent";
