import type { z } from "zod";

/**
 * Navigate a Zod schema by dotted path, unwrapping wrapper types
 * (default, optional, nullable) to reach inner object shapes.
 * Returns the Zod schema at the given path, or null if the path is invalid.
 */
export function getSchemaAtPath(
  schema: z.ZodType,
  path: string,
): z.ZodType | null {
  const keys = path.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = schema;
  for (const key of keys) {
    // Unwrap default/optional/nullable wrappers to find inner object shape
    while (current && !current.shape) {
      const inner = current._zod?.def?.innerType;
      if (!inner) break;
      current = inner;
    }
    if (!current || !current.shape) return null;
    current = current.shape[key];
    if (!current) return null;
  }
  return current;
}
