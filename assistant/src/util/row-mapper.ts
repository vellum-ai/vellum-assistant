/**
 * Generic DB row mapper — replaces repetitive parse* functions across store files.
 *
 * Each field in the schema is described by either a source column name (passthrough)
 * or a transform descriptor. The mapper produces a function that converts a raw
 * Drizzle row into a typed domain object.
 */

// A field descriptor is either a key of the source row (passthrough) or a transform.
type FieldDescriptor<TRow, TOut> =
  | (keyof TRow & string)
  | { from: keyof TRow & string; transform: (value: TRow[keyof TRow]) => TOut };

// The schema maps each output field to a field descriptor.
type MapperSchema<TRow, TDomain> = {
  [K in keyof TDomain]: FieldDescriptor<TRow, TDomain[K]>;
};

/**
 * Create a row-to-domain mapper from a declarative schema.
 *
 * Usage:
 * ```ts
 * const parseReminder = createRowMapper<typeof reminders.$inferSelect, ReminderRow>({
 *   id: 'id',
 *   label: 'label',
 *   mode: { from: 'mode', transform: (v) => v as ReminderRow['mode'] },
 * });
 * ```
 */
export function createRowMapper<TRow, TDomain>(
  schema: MapperSchema<TRow, TDomain>,
): (row: TRow) => TDomain {
  const entries = Object.entries(schema) as Array<
    [string, FieldDescriptor<TRow, unknown>]
  >;

  return (row: TRow): TDomain => {
    const result = {} as Record<string, unknown>;
    for (const [key, descriptor] of entries) {
      if (typeof descriptor === 'string') {
        result[key] = row[descriptor as keyof TRow];
      } else {
        const d = descriptor as { from: keyof TRow & string; transform: (value: TRow[keyof TRow]) => unknown };
        result[key] = d.transform(row[d.from]);
      }
    }
    return result as TDomain;
  };
}

/** Convenience: cast a value to a narrower type (for string union columns). */
export function cast<T>() {
  return (value: unknown) => value as T;
}

/** Convenience: parse a JSON string column with a fallback value on parse failure. */
export function parseJson<T>(fallback: T): (value: unknown) => T {
  return (value: unknown): T => {
    if (typeof value !== 'string' || !value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  };
}

/** Convenience: parse a JSON string column, returning null on parse failure. */
export function parseJsonNullable<T>(): (value: unknown) => T | null {
  return (value: unknown): T | null => {
    if (typeof value !== 'string' || !value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  };
}
