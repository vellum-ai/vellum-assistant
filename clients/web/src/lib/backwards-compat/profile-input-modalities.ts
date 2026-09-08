/**
 * Backwards-compat gate: per-profile `inputModalities` overrides.
 *
 * Assistants at `MIN_VERSION` and later persist `ProfileEntry.inputModalities`
 * and honor it in vision/audio send. Older assistants strip the unknown key on
 * parse while still returning a successful save, so the Modalities controls
 * and the write that carries the field stay hidden until the connected
 * assistant is known to keep the configuration.
 *
 * This gates a WRITE path whose legacy fallback (omitting the field) is
 * silently accepted, so the save path uses
 * {@link resolveSupportsProfileInputModalities} rather than the
 * conservative false-on-unknown snapshot.
 *
 * MIN_VERSION is the first commit that landed the assistant-side field
 * (`2168636b26`), stamped as a dev floor so same-source `0.11.9-dev.*` /
 * `0.11.9-local.*` builds light up and `0.11.9` stable stays on the
 * feature-off path.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import {
  assistantSupports,
  useAssistantSupports,
  whenAssistantVersionKnown,
} from "./utils";

export const MIN_VERSION = "0.11.9-dev.202609071659.2168636";

export function useSupportsProfileInputModalities(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

/**
 * Save-path gate: waits for a hydrated version, then requires that identity
 * to belong to `ownerAssistantId` when one is supplied.
 */
export async function resolveSupportsProfileInputModalities(
  ownerAssistantId?: string | null,
  versionWaitTimeoutMs?: number,
): Promise<boolean> {
  await whenAssistantVersionKnown(versionWaitTimeoutMs);
  const hydratedAssistantId = useAssistantIdentityStore.getState().assistantId;
  if (ownerAssistantId != null && hydratedAssistantId !== ownerAssistantId) {
    return false;
  }
  return assistantSupports(MIN_VERSION);
}
