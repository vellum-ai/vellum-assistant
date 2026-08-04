/**
 * Strips the design library's touch-mobile pill fill from an icon-only ghost
 * Button inside the Capacitor iOS shell, so the glyph floats bare.
 *
 * Both utilities sit outside any media query, so they apply on every iOS
 * device: `bg-transparent` outranks `touch-mobile:bg-[var(--surface-lift)]`
 * and `active:bg-transparent` outranks
 * `touch-mobile:active:bg-[var(--surface-active)]`. There is no `hover:`
 * member because Tailwind wraps that variant in `@media (hover: hover)`,
 * which a touch iPhone never matches.
 *
 * The `native-ios:` prefix differs from `touch-mobile:`, so tailwind-merge
 * keeps the design library's `touch-mobile:h-10 touch-mobile:w-10` and the
 * 40x40 tap target survives.
 */
export const NATIVE_IOS_BARE_ICON_BUTTON =
  "native-ios:bg-transparent native-ios:active:bg-transparent";
