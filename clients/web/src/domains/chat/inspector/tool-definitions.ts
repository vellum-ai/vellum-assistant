/**
 * Parses the `tool_definitions` section payload of a normalized LLM
 * request into a provider-agnostic list of tool entries the Prompt tab
 * can render structurally (name, description, input schema).
 *
 * Handles the wire shapes the assistant route emits for each provider:
 * - Anthropic custom tools: `{ name, description?, input_schema }`
 * - Anthropic server tools: `{ type: "web_search_20250305", name, ... }`
 * - OpenAI Responses functions: `{ type: "function", name, description?, parameters }`
 * - OpenAI Chat Completions: `{ type: "function", function: { name, description?, parameters } }`
 * - Gemini tool groups: `{ functionDeclarations: [{ name, description?, parameters }] }`
 */

export interface ParsedToolDefinition {
  name: string;
  /** Provider tool type when it isn't a plain function (e.g. server tools). */
  type: string | null;
  description: string | null;
  /** JSON Schema for the tool input, when the definition carries one. */
  inputSchema: Record<string, unknown> | null;
  /** Remaining definition fields (e.g. `max_uses` on server tools). */
  extras: Record<string, unknown>;
}

const SCHEMA_KEYS = ["input_schema", "parameters"] as const;
const CONSUMED_KEYS = new Set([
  "name",
  "type",
  "description",
  ...SCHEMA_KEYS,
  "function",
]);

export function parseToolDefinitions(
  data: unknown,
): ParsedToolDefinition[] | null {
  const tools = extractToolArray(data);
  if (!tools) {
    return null;
  }
  const parsed: ParsedToolDefinition[] = [];
  for (const raw of tools) {
    // Gemini groups several declarations under one tool entry.
    const declarations =
      isRecord(raw) && Array.isArray(raw.functionDeclarations)
        ? raw.functionDeclarations
        : [raw];
    for (const declaration of declarations) {
      const tool = parseTool(declaration);
      if (!tool) {
        return null;
      }
      parsed.push(tool);
    }
  }
  return parsed.length > 0 ? parsed : null;
}

function extractToolArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) {
    return data;
  }
  if (isRecord(data) && Array.isArray(data.tools)) {
    return data.tools;
  }
  return null;
}

function parseTool(raw: unknown): ParsedToolDefinition | null {
  if (!isRecord(raw)) {
    return null;
  }
  // Chat Completions nests the definition under `function`.
  const fn = isRecord(raw.function) ? raw.function : null;
  const source = fn ?? raw;
  const name = asString(source.name) ?? asString(raw.name);
  if (!name) {
    return null;
  }
  const type = asString(raw.type);
  return {
    name,
    type: type && type !== "function" ? type : null,
    description: asString(source.description),
    inputSchema: extractSchema(source) ?? (fn ? extractSchema(raw) : null),
    extras: collectExtras(raw, fn),
  };
}

function extractSchema(record: Record<string, unknown>): Record<
  string,
  unknown
> | null {
  for (const key of SCHEMA_KEYS) {
    if (isRecord(record[key])) {
      return record[key];
    }
  }
  return null;
}

function collectExtras(
  raw: Record<string, unknown>,
  fn: Record<string, unknown> | null,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const source of fn ? [raw, fn] : [raw]) {
    for (const [key, value] of Object.entries(source)) {
      if (!CONSUMED_KEYS.has(key) && value !== undefined) {
        extras[key] = value;
      }
    }
  }
  return extras;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
