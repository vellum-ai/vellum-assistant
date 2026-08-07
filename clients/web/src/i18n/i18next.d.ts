/**
 * Types `t()` keys against the English catalogs.
 *
 * i18next reads `CustomTypeOptions` to derive the union of valid key paths per
 * namespace, so `t("notFound.titel")` is a compile error, renaming a key
 * surfaces every call site, and a key read from the wrong namespace does not
 * type-check. English is the source of truth because it is the language copy is
 * authored in, and translated catalogs may legitimately lag it.
 *
 * `returnNull: false` matches the runtime `init()` option; without it every
 * `t()` return type is widened to `string | null`.
 *
 * Reference: https://www.i18next.com/overview/typescript
 */
import type account from "@/i18n/locales/en/account.json";
import type chat from "@/i18n/locales/en/chat.json";
import type common from "@/i18n/locales/en/common.json";
import type schedules from "@/i18n/locales/en/schedules.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
      chat: typeof chat;
      schedules: typeof schedules;
      account: typeof account;
    };
    returnNull: false;
  }
}
