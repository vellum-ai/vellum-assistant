import {
  DEFAULT_OPENROUTER_BASE_URL,
  OPENROUTER_APP_ATTRIBUTION_HEADERS,
} from "./client.js";

/**
 * OpenRouter ids are `author/slug` or `author/slug:variant`. A leading `~`
 * is accepted and stripped. Extra slashes and `..` are rejected so the
 * lookup path cannot escape `/api/v1/model/{author}/{slug}`.
 */
const OPENROUTER_MODEL_ID_PATTERN = /^~?[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

const LOOKUP_TIMEOUT_MS = 10_000;

export class OpenRouterModelNotFoundError extends Error {
  constructor(id: string) {
    super(`OpenRouter does not list this model ID: ${id}`);
    this.name = "OpenRouterModelNotFoundError";
  }
}

export class OpenRouterModelLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterModelLookupError";
  }
}

export class OpenRouterModelIdInvalidError extends OpenRouterModelLookupError {
  constructor() {
    super("Enter a model ID like author/model-name.");
    this.name = "OpenRouterModelIdInvalidError";
  }
}

export type OpenRouterModelLookup = {
  id: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  supportsThinking: boolean;
};

export function normalizeOpenRouterModelId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.includes("..")) {
    return null;
  }
  if (trimmed.split("/").length !== 2) {
    return null;
  }
  if (!OPENROUTER_MODEL_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^~/, "");
}

export function openRouterDisplayName(name: string, id: string): string {
  const stripped = name.replace(/^[^:]+:\s*/, "").trim();
  return stripped.length > 0 ? stripped : id;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function supportsThinkingFromRecord(record: Record<string, unknown>): boolean {
  const parameters = record.supported_parameters;
  if (!Array.isArray(parameters)) {
    return false;
  }
  return parameters.some(
    (parameter) =>
      parameter === "reasoning" || parameter === "include_reasoning",
  );
}

function lookupFromRecord(record: Record<string, unknown>): OpenRouterModelLookup {
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";
  const topProvider =
    record.top_provider !== null &&
    typeof record.top_provider === "object" &&
    !Array.isArray(record.top_provider)
      ? (record.top_provider as Record<string, unknown>)
      : {};
  return {
    id,
    displayName: openRouterDisplayName(name, id),
    contextWindowTokens: asFiniteNumber(record.context_length),
    maxOutputTokens: asFiniteNumber(topProvider.max_completion_tokens),
    supportsThinking: supportsThinkingFromRecord(record),
  };
}

export async function lookupOpenRouterModel(
  rawId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OpenRouterModelLookup> {
  const id = normalizeOpenRouterModelId(rawId);
  if (id === null) {
    throw new OpenRouterModelIdInvalidError();
  }

  const slash = id.indexOf("/");
  const author = id.slice(0, slash);
  const slug = id.slice(slash + 1);
  const url = `${DEFAULT_OPENROUTER_BASE_URL}/model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: OPENROUTER_APP_ATTRIBUTION_HEADERS,
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenRouterModelLookupError(
      `Could not reach OpenRouter to check this model ID: ${message}`,
    );
  }

  if (response.status === 404) {
    throw new OpenRouterModelNotFoundError(id);
  }
  if (!response.ok) {
    throw new OpenRouterModelLookupError(
      `OpenRouter returned HTTP ${response.status} while checking this model ID.`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OpenRouterModelLookupError(
      "OpenRouter returned an unreadable response while checking this model ID.",
    );
  }

  const record =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload &&
    (payload as { data: unknown }).data !== null &&
    typeof (payload as { data: unknown }).data === "object" &&
    !Array.isArray((payload as { data: unknown }).data)
      ? ((payload as { data: Record<string, unknown> }).data)
      : payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;

  if (record === null || typeof record.id !== "string" || record.id.length === 0) {
    throw new OpenRouterModelLookupError(
      "OpenRouter returned an unexpected model payload.",
    );
  }

  return lookupFromRecord(record);
}
