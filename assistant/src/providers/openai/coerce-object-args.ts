/**
 * Some OpenAI-compatible models (notably minimax-m3 served via Fireworks)
 * collapse nested *object*-typed tool arguments to `{}` during their
 * function-call serialization, while scalars and arrays survive intact. The
 * model reasons correctly about the intended fields, but the object value is
 * lost on the wire before it reaches us as valid-but-empty JSON, so there is
 * nothing to recover at parse time.
 *
 * The workaround presents every top-level object-typed parameter to the model
 * as a `string` it fills with JSON (strings survive the serializer), then
 * decodes that string back into an object before dispatch. The transform is a
 * matched pair — {@link coerceObjectParamsToJsonString} on the outbound schema
 * and {@link decodeCoercedObjectArgs} on the inbound tool-call arguments — and
 * is gated to the affected providers so other models keep native object
 * passthrough.
 */

interface ObjectSchemaLike {
  type?: unknown;
  properties?: Record<string, { type?: unknown; description?: string }>;
}

function isObjectTyped(prop: { type?: unknown }): boolean {
  if (prop?.type === "object") return true;
  if (Array.isArray(prop?.type) && prop.type.includes("object")) return true;
  return false;
}

export interface CoercedToolSchema {
  /** The tool's JSON schema with object params rewritten to JSON-string params. */
  parameters: Record<string, unknown>;
  /** Top-level param keys that were object-typed and are now JSON strings. */
  objectKeys: string[];
}

/**
 * Rewrite top-level `type: "object"` properties of a tool's input schema into
 * `type: "string"` params the model fills with JSON. Returns the rewritten
 * schema plus the list of converted keys so the inbound side can reverse it.
 * Non-object params (scalars, arrays) are passed through unchanged. Arrays and
 * deeper-nested objects are intentionally left alone — only top-level object
 * params are observed to collapse.
 */
export function coerceObjectParamsToJsonString(
  inputSchema: unknown,
): CoercedToolSchema {
  const schema = inputSchema as ObjectSchemaLike | undefined;
  if (!schema || schema.type !== "object" || !schema.properties) {
    return {
      parameters: (inputSchema as Record<string, unknown>) ?? {},
      objectKeys: [],
    };
  }

  const objectKeys: string[] = [];
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (isObjectTyped(prop)) {
      objectKeys.push(key);
      properties[key] = {
        type: "string",
        description:
          `${prop.description ?? ""}\n\nPass this argument as a JSON object encoded as a string, e.g. "{\\"key\\": \\"value\\"}".`.trim(),
      };
    } else {
      properties[key] = prop;
    }
  }

  return { parameters: { ...schema, properties }, objectKeys };
}

/**
 * Reverse {@link coerceObjectParamsToJsonString}: for each coerced key whose
 * value arrived as a string, JSON-parse it back into an object. Values that are
 * already objects (e.g. replayed conversation history, or a model that sent the
 * object natively) are left untouched, so the decode is idempotent. An empty
 * string decodes to `{}`. If a non-empty string fails to parse, the key name is
 * returned in `failedKey` so the caller can surface a retryable error instead of
 * silently dispatching garbage.
 */
export function decodeCoercedObjectArgs(
  input: Record<string, unknown>,
  objectKeys: string[],
): { input: Record<string, unknown>; failedKey?: string } {
  if (objectKeys.length === 0) return { input };

  const result: Record<string, unknown> = { ...input };
  for (const key of objectKeys) {
    const value = result[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") {
      result[key] = {};
      continue;
    }
    try {
      result[key] = JSON.parse(trimmed);
    } catch {
      return { input: result, failedKey: key };
    }
  }
  return { input: result };
}
