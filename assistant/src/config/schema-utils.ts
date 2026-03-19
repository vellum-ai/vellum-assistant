import type { z } from "zod";

/**
 * Unwrap a Zod schema to reach its inner object shape, handling:
 * - default/optional/nullable wrappers (innerType)
 * - pipe/transform wrappers (in — the input side)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapToShape(schema: any): any {
  let current = schema;
  while (current && !current.shape) {
    const def = current._zod?.def;
    if (!def) break;
    // Pipe/transform: follow the input side to get the pre-transform schema
    if (def.type === "pipe" && def.in) {
      current = def.in;
      continue;
    }
    // Default/optional/nullable: follow innerType
    if (def.innerType) {
      current = def.innerType;
      continue;
    }
    break;
  }
  return current;
}

/**
 * Navigate a Zod schema by dotted path, unwrapping wrapper types
 * (default, optional, nullable, pipe/transform) to reach inner object shapes.
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
    current = unwrapToShape(current);
    if (!current || !current.shape) return null;
    current = current.shape[key];
    if (!current) return null;
  }
  return current;
}
