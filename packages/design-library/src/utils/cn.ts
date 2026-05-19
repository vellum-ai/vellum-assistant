import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Custom typography `@utility` classes defined in `tokens.css`. These set
 * font-family / font-size / font-weight / line-height — NOT text color.
 *
 * By default `tailwind-merge` classifies any unknown `text-*` class as
 * text-color and deduplicates it against real color utilities like
 * `text-[color:var(--token)]` or `text-white`. Registering these names
 * under the `font-size` class group tells twMerge they are typography
 * utilities so they coexist with text-color classes instead of conflicting.
 *
 * When adding a new `@utility text-*` class in `tokens.css`, add the
 * suffix here too (e.g. `text-heading-xl` → add `"heading-xl"`).
 *
 * @see https://github.com/dcastil/tailwind-merge/blob/main/docs/configuration.md#class-groups
 */
const TYPOGRAPHY_UTILITIES = [
  "title-large",
  "title-medium",
  "title-small",
  "body-large-default",
  "body-large-lighter",
  "body-medium-default",
  "body-medium-lighter",
  "body-small-default",
  "body-small-emphasised",
  "label-medium-default",
  "label-small-default",
  "chat",
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: TYPOGRAPHY_UTILITIES }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
