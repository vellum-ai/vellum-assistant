/**
 * Failure body of a `.vbundle` import from the assistant's migration routes:
 * a structured validation report (`reason` plus per-file `errors`) or a plain
 * `message`. Clients that restore bundles parse it to tell the owner which
 * file failed instead of printing raw JSON.
 */

import { z } from "zod";

export const importFailureSchema = z.object({
  reason: z.string().optional(),
  message: z.string().optional(),
  errors: z
    .array(z.object({ message: z.string(), path: z.string().optional() }))
    .optional(),
});

export type ImportFailure = z.infer<typeof importFailureSchema>;

/** Parse an import failure from JSON text, or null when the text is not one. */
export function parseImportFailure(text: string): ImportFailure | null {
  try {
    const parsed = importFailureSchema.safeParse(JSON.parse(text));
    return parsed.success &&
      (parsed.data.reason || parsed.data.message || parsed.data.errors)
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
