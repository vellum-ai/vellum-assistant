/**
 * `client_settings_update` SSE event.
 *
 * Server → client instruction to update a single client-side setting
 * (e.g. the voice activation key). `key` names the setting and `value`
 * is its new value, always sent as a string.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ClientSettingsUpdateEventSchema = z.object({
  type: z.literal("client_settings_update"),
  /** The setting key to update (e.g. "activationKey"). */
  key: z.string(),
  /** The new value for the setting. */
  value: z.string(),
});

export type ClientSettingsUpdateEvent = z.infer<
  typeof ClientSettingsUpdateEventSchema
>;
