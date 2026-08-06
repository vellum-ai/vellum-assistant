/**
 * The i18next `init()` options, in one place.
 *
 * Both the app (`i18n.ts`) and the test preload (`test-setup.ts`) initialize
 * the same i18next singleton, and they must configure it identically: a test
 * that formats messages under different options is testing something the app
 * never runs. Sharing the factory makes that structural instead of a comment
 * asking two files to stay in sync.
 *
 * Kept free of any dependency on locale *resolution* (`system-locale.ts`,
 * `device-settings.ts`) so importing it from the preload does not pull those
 * modules into the registry ahead of the tests that mock them.
 */
import type { InitOptions } from "i18next";

import { DEFAULT_NAMESPACE, type Catalog } from "@/i18n/catalogs";
import { DEFAULT_LOCALE } from "@/i18n/supported-locales";

export function i18nextInitOptions(
  locale: string,
  resources: Record<string, Catalog>,
): InitOptions {
  return {
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    ns: [DEFAULT_NAMESPACE],
    defaultNS: DEFAULT_NAMESPACE,
    resources: Object.fromEntries(
      Object.entries(resources).map(([tag, catalog]) => [
        tag,
        { [DEFAULT_NAMESPACE]: catalog },
      ]),
    ),
    // React escapes interpolated values on render; letting i18next escape them
    // too double-encodes apostrophes and ampersands in user data.
    interpolation: { escapeValue: false },
    returnNull: false,
  };
}
