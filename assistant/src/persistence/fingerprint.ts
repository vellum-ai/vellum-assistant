import { createHash } from "node:crypto";

/**
 * Compute a scope-salted fingerprint for a memory item.
 *
 * Format: sha256(`${scopeId}|${kind}|${subject}|${statement}`)
 *
 * All writers (memory_manage save/update ops, items-extractor,
 * gmail-analyze-style) MUST use this function so the
 * fingerprint scheme stays consistent and deduplication works correctly.
 */
export function computeMemoryFingerprint(
  scopeId: string,
  kind: string,
  subject: string,
  statement: string,
): string {
  const normalized = `${scopeId}|${kind}|${subject.toLowerCase()}|${statement.toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex");
}
