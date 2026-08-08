/**
 * Register the PowerPoint viewer's UI strings with the app's translator.
 *
 * `pptx-react-viewer` ships no translations of its own: every label in its
 * chrome is a `t("pptx.…")` call against the *host's* `react-i18next`
 * instance, and the package exports the English dictionary for the host to
 * install. Without this, the viewer renders raw keys — a ribbon reading
 * `pptx.ribbon.tab.home` instead of "Home".
 *
 * Two shape mismatches have to be bridged:
 *
 * 1. The dictionary is flat, keyed by dotted strings, while this app leaves
 *    i18next's default `.` key separator on — so a flat bundle would be stored
 *    under literal dotted keys that lookup never traverses to. The keys are
 *    expanded into the nested object i18next walks.
 * 2. The viewer calls `useTranslation()` with no namespace, so the strings must
 *    land in the default namespace. Every key is under a single `pptx` root, so
 *    this adds one subtree to `common` and cannot collide with app strings.
 *
 * English only — that is all the package ships. Other locales fall back to it,
 * which is the same behaviour as an untranslated app string.
 */

import { translationsEn } from "pptx-react-viewer/i18n";

import { addTranslationSubtree } from "@/i18n";

let registered = false;

/**
 * Rewrite i18next's `{{name}}` interpolation to ICU's `{name}`.
 *
 * The dictionary is written for i18next's default mustache interpolation, but
 * this app runs `i18next-icu`, which parses messages as ICU MessageFormat and
 * leaves a `{{name}}` placeholder untouched — the status bar reads
 * "Slide {{current}} of {{total}}" verbatim. 131 of the viewer's strings
 * interpolate, so they are converted rather than accepted as broken.
 *
 * Only the placeholder syntax is bridged. A vendor string using i18next's
 * `_plural` key suffixes would still not pluralise the way ICU's `plural{}`
 * does; none currently do, and the failure mode there is an English plural
 * form, not a visible placeholder.
 */
function toIcuInterpolation(value: string): string {
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, "{$1}");
}

/** Expand `{"a.b": "x"}` into `{a: {b: "x"}}`. */
function expandDottedKeys(flat: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [dotted, value] of Object.entries(flat)) {
    const segments = dotted.split(".");
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i]!;
      const existing = node[segment];
      // A dictionary carrying both `a.b` and `a.b.c` cannot be represented as a
      // tree. Preferring the deeper entry keeps the branch walkable; the
      // shallower string would be unreachable through a `.` separator anyway.
      if (typeof existing !== "object" || existing === null) {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1]!;
    if (typeof node[leaf] !== "object" || node[leaf] === null) {
      node[leaf] = toIcuInterpolation(value);
    }
  }
  return root;
}

/**
 * Idempotent — both PowerPoint surfaces call it on mount, and either may be the
 * first to render.
 */
export function registerPptxTranslations(): void {
  if (registered) {
    return;
  }
  registered = true;
  addTranslationSubtree(expandDottedKeys(translationsEn));
}
