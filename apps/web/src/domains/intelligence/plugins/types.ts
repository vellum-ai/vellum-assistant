/**
 * Domain type aliases for the assistant plugins surface.
 *
 * These derive directly from the generated daemon SDK response types,
 * which are themselves generated from the daemon route `responseBody`
 * Zod schemas in `assistant/src/runtime/routes/plugins-routes.ts`.
 * Keeping them as thin aliases means the web app never re-declares the
 * plugin shapes — the daemon route schema is the single source of truth,
 * so the types cannot drift from the wire contract.
 */

import type {
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

/** Response envelope for `GET /v1/assistants/{id}/plugins`. */
export type PluginsListResponse = PluginsGetResponse;

/**
 * A single installed plugin surfaced to the UI. `description`/`version`
 * are `null` when unknown; `path`/`issues` are omitted when clean.
 */
export type PluginInfo = PluginsGetResponse["plugins"][number];

/** Response envelope for `GET /v1/assistants/{id}/plugins/search`. */
export type PluginCatalogResponse = PluginsSearchGetResponse;

/**
 * A single catalog directory match — installable with
 * `assistant plugins install <name>`.
 */
export type PluginCatalogMatch = PluginsSearchGetResponse["matches"][number];
