/**
 * Runtime identity for the assistant: name, role, personality, emoji,
 * home, version, and (optionally) creation timestamp.
 *
 * Fetched from the daemon through the wildcard proxy. Returns `null`
 * when the identity cannot be retrieved (the assistant is still
 * initializing, the runtime is unreachable, etc.) so the caller can
 * fall back to a stub.
 */
import { identityGet } from "@/generated/daemon/sdk.gen";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import { assertHasResponse } from "@/utils/api-errors";

export async function fetchAssistantIdentity(
  assistantId: string,
): Promise<IdentityGetResponse | null> {
  try {
    const { data, error, response } = await identityGet({
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
