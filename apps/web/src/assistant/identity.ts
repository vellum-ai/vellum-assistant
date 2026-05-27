/**
 * Runtime identity for the assistant: name, role, personality, emoji,
 * home, version, and (optionally) creation timestamp.
 *
 * Fetched from the daemon through the wildcard proxy. Returns `null`
 * when the identity cannot be retrieved (the assistant is still
 * initializing, the runtime is unreachable, etc.) so the caller can
 * fall back to a stub.
 */
import { client } from "@/generated/api/client.gen";
import { assertHasResponse } from "@/lib/api-errors";

// `client.get` needs a baseUrl when there's no `window` (SSR / unit tests).
const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

export interface AssistantIdentity {
  name: string;
  role: string;
  personality: string;
  emoji: string;
  home: string;
  version: string;
  createdAt?: string;
}

export async function fetchAssistantIdentity(
  assistantId: string,
): Promise<AssistantIdentity | null> {
  try {
    const { data, error, response } = await client.get<AssistantIdentity, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/identity/",
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch assistant identity");

    if (!response.ok || !data || typeof data !== "object") {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}
