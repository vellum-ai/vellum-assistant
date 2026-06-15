/**
 * Deterministic JSON stringify with recursively sorted object keys.
 *
 * Used by the workflow engine and sandbox so marshalled values that feed the
 * resume hash (`call_hash = sha256(deterministicStringify({ prompt, opts }))`)
 * and host-call results are stable regardless of insertion order. `undefined`
 * round-trips to the string `"null"` (top-level `JSON.stringify(undefined)` is
 * itself `undefined`, which the `?? "null"` fallback maps to `"null"`); JSON
 * has no `undefined`.
 *
 * The byte-for-byte output of this function is load-bearing: it feeds the
 * resume hash, so any change to its serialization would silently invalidate
 * every existing journal's cached prefix. Do not "improve" it.
 */
export function deterministicStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}
