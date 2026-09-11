/**
 * `app_files_changed` SSE event.
 *
 * Broadcast after an app is created, compiled, or otherwise updated so
 * connected clients re-read the app (refresh preview, reload the running
 * surface). Workspace compiles go through `assistant apps refresh` or
 * `app_refresh`; file edits do not emit this on their own.
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
