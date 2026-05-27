/**
 * Hand-written fetch wrapper for extracting inference profile metadata
 * from the assistant daemon's config endpoint. Not in the OpenAPI schema.
 */

import { client } from "@/generated/api/client.gen";

export interface UsageProfileMetadata {
  id: string;
  displayName: string;
  description?: string;
}

export type UsageProfileMetadataMap = Record<string, UsageProfileMetadata>;

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
  if (
    !isRecord(config) ||
    !isRecord(config.llm) ||
    !isRecord(config.llm.profiles)
  ) {
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
  const { data, response } = await client.get<Record<string, unknown>>({
    url: "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  if (!response || !response.ok) {
    const text = await response
      ?.clone()
      .text()
      .catch(() => "");
    throw new Error(
      text ||
        response?.statusText ||
        "Failed to load inference profile metadata.",
    );
  }
  return extractUsageProfileMetadata(data);
}
