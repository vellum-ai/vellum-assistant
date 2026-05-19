import { client } from "@/generated/api/client.gen.js";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api/errors.js";

import "@/lib/vellum-api/client.js";

export interface UsageProfileMetadata {
  id: string;
  displayName: string;
  description?: string;
}

export type UsageProfileMetadataMap = Record<string, UsageProfileMetadata>;

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function extractUsageProfileMetadata(
  config: unknown,
): UsageProfileMetadataMap {
  if (!isRecord(config) || !isRecord(config.llm) || !isRecord(config.llm.profiles)) {
    return {};
  }

  const metadata: UsageProfileMetadataMap = {};
  for (const [id, profile] of Object.entries(config.llm.profiles)) {
    if (!isRecord(profile)) {
      continue;
    }

    const displayName = nonEmptyString(profile.label) ?? id;
    const description = nonEmptyString(profile.description);
    metadata[id] = {
      id,
      displayName,
      ...(description ? { description } : {}),
    };
  }

  return metadata;
}

export async function fetchUsageProfileMetadata(
  assistantId: string,
): Promise<UsageProfileMetadataMap> {
  const { data, error, response } = await client.get<
    Record<string, unknown>,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to load inference profile metadata.",
  );
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Failed to load inference profile metadata.",
      ),
    );
  }
  return extractUsageProfileMetadata(data);
}
