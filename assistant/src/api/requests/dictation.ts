/**
 * Wire contract for the dictation REST endpoint (`POST /dictation`).
 *
 * The body web/macOS sends when asking the daemon to clean up a raw voice
 * transcript and classify it as dictation vs. action. `context` is its own
 * named schema/type so consumers (web client) can import `DictationContext`
 * directly instead of inferring it from the generated client.
 *
 * Canonical wire-contract source. Assistant code imports the types/schema
 * directly from this file via relative paths (the daemon route sources its
 * `requestBody` from here); external consumers (web client, gateway, evals)
 * import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

/**
 * Context describing where dictation was initiated (app, window, cursor
 * state, selected text). Strip-mode passthrough: clients send the subset
 * they have — web sends only `cursorInTextField`, macOS sends the full set —
 * and the daemon tolerates additional fields without rejecting the request.
 */
export const DictationContextSchema = z
  .object({
    cursorInTextField: z
      .boolean()
      .optional()
      .describe(
        "Whether the cursor is in an editable text field when dictation started",
      ),
  })
  .passthrough()
  .describe(
    "Dictation context (app name, window title, bundle ID, cursor state, selected text)",
  );

export type DictationContext = z.infer<typeof DictationContextSchema>;

export const DictationRequestSchema = z.object({
  transcription: z.string().describe("Raw speech transcription"),
  context: DictationContextSchema,
  profileId: z.string().describe("Optional dictation profile ID").optional(),
});

export type DictationRequest = z.infer<typeof DictationRequestSchema>;
