/**
 * Classes for an affordance a row keeps out of the way until it is wanted: an
 * inline "..." trigger, a remove button, a preview overlay laid over artwork.
 *
 * The affordance hides only where the device can hover. `hover` and `pointer`
 * are independent media features, and neither follows from viewport width, so
 * a roomy surface is no evidence of a mouse: an iPad in landscape reports
 * `hover: none` at 1024px. A control hidden behind a hover the device cannot
 * perform is unreachable rather than merely tucked away, so where there is no
 * hover the affordance is simply present.
 *
 * The keyboard path mirrors the pointer one. Focus anywhere in the row reveals
 * the affordance, and a menu the trigger owns holds it visible while focus
 * sits inside the portalled content, where `group-focus-within` alone would
 * let it fade mid-interaction.
 *
 * The row itself must carry Tailwind's unnamed `group` class for the hover and
 * focus conditions to resolve. A row whose group is named cannot simply add the
 * unnamed one alongside it: `group-*` compiles to an ancestor selector, so
 * every unnamed group in the subtree would then also answer to a hover
 * anywhere on the row. Such a row spells these conditions out against its own
 * group name instead.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer
 * @see https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus
 */
export const hoverRevealClasses = [
  "opacity-0 transition-opacity",
  "[@media(hover:none)]:opacity-100",
  "[@media(hover:hover)]:group-hover:opacity-100",
  "group-focus-within:opacity-100",
  "has-[[aria-expanded=true]]:opacity-100",
].join(" ");

/**
 * The inverse of {@link hoverRevealClasses}, for an element that occupies the
 * same slot as the revealed affordance and must yield it: a selected-state
 * check a preview button takes over from, a timestamp a row's actions replace.
 *
 * The two conditions have to be the same condition. A slot whose occupant
 * appears wherever the device cannot hover, beside one that only leaves on
 * hover, shows both at once and stacks them.
 */
export const hoverRevealYieldClasses = [
  "opacity-100 transition-opacity",
  "[@media(hover:none)]:opacity-0",
  "[@media(hover:hover)]:group-hover:opacity-0",
  "group-focus-within:opacity-0",
  "group-has-[[aria-expanded=true]]:opacity-0",
].join(" ");
