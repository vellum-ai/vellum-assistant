import { z } from "zod";

export const OPENROUTER_PUBLIC_BASE_URL = "https://openrouter.ai/api/v1";

const OPENROUTER_MODEL_ID_PATTERN = /^~?[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

const LOOKUP_TIMEOUT_MS = 10_000;

const OpenRouterModelRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  context_length: z.number().positive().optional(),
  top_provider: z
    .object({
      max_completion_tokens: z.number().positive().optional(),
    })
    .nullable()
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
});

const OpenRouterModelLookupResponseSchema = z.union([
  z.object({ data: OpenRouterModelRecordSchema }),
  OpenRouterModelRecordSchema,
]);

export class OpenRouterModelIdInvalidError extends Error {
  constructor() {
    super("Enter a model ID like author/model-name.");
    this.name = "OpenRouterModelIdInvalidError";
  }
}

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

export type OpenRouterModelLookup = {
  id: string;
  displayName: string;
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

export function openRouterDisplayName(name: string | undefined, id: string): string {
  const stripped = name?.replace(/^[^:]+:\s*/, "").trim() ?? "";
  return stripped.length > 0 ? stripped : id;
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
  const url = `${OPENROUTER_PUBLIC_BASE_URL}/model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "HTTP-Referer": "https://www.vellum.ai",
        "X-OpenRouter-Title": "Vellum Assistant",
      },
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

  const parsed = OpenRouterModelLookupResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new OpenRouterModelLookupError(
      "OpenRouter returned an unexpected model payload.",
    );
  }

  const record = "data" in parsed.data ? parsed.data.data : parsed.data;
  return {
    id: record.id,
    displayName: openRouterDisplayName(record.name, record.id),
  };
}
