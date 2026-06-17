import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Register the 12 canonical app typography utility classes (defined in
 * `src/app/globals.css`) under tailwind-merge's `font-size` group.
 *
 * Without this extension, `tailwind-merge` treats unrecognized `text-*`
 * tokens as ambiguous and collapses them against arbitrary color classes
 * like `text-[color:var(--x)]`. That would silently strip the typography
 * class from any element that also carries a CSS-variable text color.
 *
 * See `src/components/app/core/Typography/Typography.tsx` for the source
 * of truth. The array here mirrors `TypographyVariant` (kept flat to stay
 * ignorant of that module's import graph).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-title-large",
        "text-title-medium",
        "text-title-small",
        "text-body-large-lighter",
        "text-body-large-default",
        "text-body-medium-lighter",
        "text-body-medium-default",
        "text-body-small-default",
        "text-body-small-emphasised",
        "text-label-medium-default",
        "text-label-small-default",
        "text-chat",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
