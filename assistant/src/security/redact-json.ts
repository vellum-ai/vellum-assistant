/**
 * JSON-aware secret redaction: walk a parsed JSON value and run
 * `redactSecrets()` over every string leaf (object keys included).
 *
 * The redaction marker (`<redacted type="..." />`) contains double quotes,
 * so splicing it into an already-serialized JSON document corrupts any
 * string it lands inside. Callers that need to keep serialized JSON valid
 * must redact the string leaves of the parsed value and re-stringify,
 * rather than redacting the serialized text.
 *
 * Shared by the export-time staged-file sweep (`redact-staged-export.ts`)
 * and the tool-audit listener (`tool-audit-listener.ts`). The hot-path pino
 * log serializer (`util/log-redact.ts`) intentionally does not use this
 * module.
 */

import { redactSecrets } from "./secret-scanner.js";

export interface RedactedJsonValue {
  /** Redacted copy of the input (the input itself is never mutated). */
  value: unknown;
  /** True when at least one string leaf was changed by redaction. */
  changed: boolean;
}

interface RedactionState {
  changed: boolean;
}

/**
 * Redact secrets in every string leaf (keys included) of a parsed JSON
 * value. Returns the redacted copy plus a `changed` flag so callers can
 * keep unchanged content byte-identical (no gratuitous re-serialization).
 */
export function redactJsonStringLeaves(value: unknown): RedactedJsonValue {
  const state: RedactionState = { changed: false };
  return { value: walk(value, state), changed: state.changed };
}

function walk(value: unknown, state: RedactionState): unknown {
  if (typeof value === "string") {
    return redactString(value, state);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, state));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(
        ([key, val]) => [redactString(key, state), walk(val, state)] as const,
      ),
    );
  }
  return value;
}

function redactString(value: string, state: RedactionState): string {
  const redacted = redactSecrets(value);
  if (redacted !== value) state.changed = true;
  return redacted;
}
