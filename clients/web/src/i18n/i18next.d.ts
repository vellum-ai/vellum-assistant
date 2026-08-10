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
import type channels from "@/i18n/locales/en/channels.json";
import type contacts from "@/i18n/locales/en/contacts.json";
import type credentialRequests from "@/i18n/locales/en/credential-requests.json";
import type home from "@/i18n/locales/en/home.json";
import type library from "@/i18n/locales/en/library.json";
import type logs from "@/i18n/locales/en/logs.json";
import type remoteWeb from "@/i18n/locales/en/remote-web.json";
import type terminal from "@/i18n/locales/en/terminal.json";
import type workspace from "@/i18n/locales/en/workspace.json";
import type chat from "@/i18n/locales/en/chat.json";
import type common from "@/i18n/locales/en/common.json";
import type schedules from "@/i18n/locales/en/schedules.json";
import type settings from "@/i18n/locales/en/settings.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
      chat: typeof chat;
      schedules: typeof schedules;
      account: typeof account;
      channels: typeof channels;
      settings: typeof settings;
      workspace: typeof workspace;
      terminal: typeof terminal;
      "remote-web": typeof remoteWeb;
      "credential-requests": typeof credentialRequests;
      logs: typeof logs;
      library: typeof library;
      home: typeof home;
      contacts: typeof contacts;
    };
    returnNull: false;
  }
}
