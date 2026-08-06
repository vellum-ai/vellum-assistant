/**
 * Types `t()` keys against the English catalog.
 *
 * i18next reads `CustomTypeOptions` to derive the union of valid key paths, so
 * `t("notFound.titel")` is a compile error and renaming a key surfaces every
 * call site. English is the source of truth because it is the language copy is
 * authored in, and translated catalogs may legitimately lag it.
 *
 * `returnNull: false` matches the runtime `init()` option; without it every
 * `t()` return type is widened to `string | null`.
 *
 * Reference: https://www.i18next.com/overview/typescript
 */
import type common from "@/i18n/locales/en/common.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
    };
    returnNull: false;
  }
}
