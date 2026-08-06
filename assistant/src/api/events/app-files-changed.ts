/**
 * `app_files_changed` SSE event.
 *
 * Broadcast when an app's source files change on disk — emitted when a new
 * app is created and by the app source watcher on edits — so connected
 * clients re-read the app (refresh preview, reload the running surface).
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AppFilesChangedEventSchema = z.object({
  type: z.literal("app_files_changed"),
  appId: z.string(),
});

export type AppFilesChangedEvent = z.infer<typeof AppFilesChangedEventSchema>;
