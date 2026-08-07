/**
 * The i18next `init()` options, in one place.
 *
 * The app (`i18n.ts`), the test preload (`test-setup.ts`), and the Storybook
 * preview all initialize the same i18next singleton, and they must configure it
 * identically: a test or a story that formats messages under different options
 * is exercising something the app never runs. Sharing the factory makes that
 * structural instead of a comment asking three files to stay in sync.
 *
 * Kept free of any dependency on locale *resolution* (`system-locale.ts`,
 * `device-settings.ts`) so importing it from the preload does not pull those
 * modules into the registry ahead of the tests that mock them.
 */
import type { InitOptions } from "i18next";

import type { LocaleCatalogs } from "@/i18n/catalogs";
import { DEFAULT_NAMESPACE, NAMESPACES } from "@/i18n/namespaces";
import { DEFAULT_LOCALE } from "@/i18n/supported-locales";

export function i18nextInitOptions(
  locale: string,
  resources: Record<string, LocaleCatalogs>,
): InitOptions {
  return {
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    resources,
    // React escapes interpolated values on render; letting i18next escape them
    // too double-encodes apostrophes and ampersands in user data.
    interpolation: { escapeValue: false },
    returnNull: false,
  };
}
