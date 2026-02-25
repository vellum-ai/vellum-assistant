import type { z } from 'zod';

/**
 * Apply `.default({})` to a Zod object schema whose fields all carry their own
 * defaults.  Zod fills in inner defaults at parse time, but its `.default()`
 * overload expects the **output** type, so TypeScript rejects the literal `{}`.
 * This wraps the cast in a single location.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function emptyDefault<T extends z.ZodType>(schema: T): z.ZodDefault<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (schema as any).default({});
}
