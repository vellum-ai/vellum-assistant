/**
 * Translation namespaces, and the rule for which one a string belongs to.
 *
 * A namespace is one catalog file per locale. The split exists for source
 * control before it exists for organization: a single catalog edited by
 * everyone converting a different screen is a merge-conflict magnet, and JSON
 * conflicts resolve badly. One namespace per domain keeps concurrent
 * conversions in different files.
 *
 * **Which namespace does a string go in?** The one matching the directory that
 * owns the component:
 *
 * - `src/domains/<name>/` maps to the `<name>` namespace.
 * - `src/components/`, `src/hooks/`, `src/utils/`, and anything else
 *   cross-domain maps to `common`.
 *
 * That mirrors the boundary `local/no-cross-domain-imports` already enforces,
 * so a string never has to move because the code did not.
 *
 * **Key naming inside a namespace** is `<component>.<slot>`, camelCase, where
 * `<component>` is the component's own name, lowercased at the first letter:
 * `notFound.title`, `conversationAssets.ariaLabel`. Do not repeat the
 * namespace in the key (`chat:conversationAssets.label`, never
 * `chat:chat.conversationAssets.label`). Do not name a key for the English
 * copy it currently holds (`saveButton.label`, never `clickHereToSave`); the
 * copy changes and the key should not have to.
 */

/**
 * Namespaces with a catalog on disk.
 *
 * Adding one means: add the tag here, add `<ns>.json` under every locale in
 * `locales/`, and add the loader entries in `catalogs.ts`. All three are
 * checked at compile time, so a half-finished addition fails `tsc` rather than
 * rendering raw key paths at runtime.
 */
export const NAMESPACES = [
  "common",
  "chat",
  "schedules",
  "account",
  "channels",
  "settings",
  "workspace",
  "terminal",
  "remote-web",
  "credential-requests",
  "logs",
  "library",
  "home",
  "contacts",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/**
 * The namespace used when a call site does not name one. `common` holds the
 * cross-domain strings, which are the ones most likely to be reached from a
 * component that has no domain of its own.
 */
export const DEFAULT_NAMESPACE = "common";
