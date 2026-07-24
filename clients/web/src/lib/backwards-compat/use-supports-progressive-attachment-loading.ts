/**
 * Backwards-compat gate for progressive transcript attachment loading.
 *
 * Assistants below 0.10.12 may not understand either the
 * `attachmentContent=metadata` history query or the `representation=display`
 * content query. Once their identity resolves (or the bounded wait expires),
 * their transcripts request inline history payloads, and referenced-image
 * fallbacks use the content endpoint's default original representation.
 * Assistants at 0.10.12 and above return stable attachment metadata and serve
 * display representations near the viewport.
 *
 * The gate is scoped to the assistant that owns the transcript so a switch
 * cannot briefly apply one assistant's version to another assistant's history.
 */
import { useEffect, useState } from "react";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import {
  useAssistantScopedSupports,
  VERSION_RESOLUTION_TIMEOUT_MS,
} from "./utils";

export const MIN_VERSION = "0.10.12";

export type ProgressiveAttachmentLoadingPolicy =
  | "pending"
  | "inline"
  | "metadata";

/** Returns whether the transcript may use progressive attachment requests. */
export function useSupportsProgressiveAttachmentLoading(
  transcriptAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, transcriptAssistantId);
}

/**
 * Resolves the attachment-history request policy for one assistant.
 *
 * History waits while the requested assistant's identity is unresolved rather
 * than starting the expensive inline request. A known older assistant uses the
 * legacy inline payload, and supported assistants use metadata-only history.
 * The timeout bounds the wait when identity cannot hydrate; that fallback uses
 * the universally-supported inline request.
 */
export function useProgressiveAttachmentLoadingPolicy(
  transcriptAssistantId: string | null | undefined,
  timeoutMs: number = VERSION_RESOLUTION_TIMEOUT_MS,
): ProgressiveAttachmentLoadingPolicy {
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const version = useAssistantIdentityStore.use.version();
  const supportsProgressiveAttachmentLoading =
    useSupportsProgressiveAttachmentLoading(transcriptAssistantId);

  const [timedOutAssistantId, setTimedOutAssistantId] = useState<string | null>(
    null,
  );

  const identityResolved =
    transcriptAssistantId != null &&
    identityAssistantId === transcriptAssistantId &&
    version != null;

  useEffect(() => {
    setTimedOutAssistantId(null);
    if (!transcriptAssistantId || identityResolved) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setTimedOutAssistantId(transcriptAssistantId);
    }, timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [transcriptAssistantId, identityResolved, timeoutMs]);

  if (supportsProgressiveAttachmentLoading) {
    return "metadata";
  }
  if (identityResolved) {
    return "inline";
  }
  if (
    transcriptAssistantId != null &&
    timedOutAssistantId === transcriptAssistantId
  ) {
    return "inline";
  }
  return "pending";
}
