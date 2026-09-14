/**
 * Assistants before 0.8.4 have no document-conversation link endpoint.
 * They retain the browser's cached edit conversation without a link write.
 * Supported assistants persist the link before navigation.
 */
import { assistantScopedSupports, whenAssistantVersionKnownFor } from "./utils";

export const MIN_VERSION = "0.8.4";

export async function resolveSupportsDocumentConversationLink(
  assistantId: string | null | undefined,
): Promise<boolean> {
  await whenAssistantVersionKnownFor(assistantId);
  return assistantScopedSupports(MIN_VERSION, assistantId);
}
