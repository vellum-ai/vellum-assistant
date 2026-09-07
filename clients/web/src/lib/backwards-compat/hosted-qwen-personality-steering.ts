/**
 * Backwards-compat gate: hosted-Qwen personality sliders without rewrite.
 *
 * Daemons at `MIN_VERSION` and later attach `directions` from
 * `data/personality-sliders.json` on the `vellum` + `qwen/qwen3-8b`
 * chat path. Older daemons can already expose that model but ignore
 * the sidecar, so skipping the identity rewrite would report success
 * while IDENTITY.md / SOUL.md stay unchanged. Below the floor the
 * personality page keeps the rewrite.
 *
 * The floor is the dev version of b0187704f0, the assistant commit
 * that puts `directions` on the OpenAI create body. Base-version
 * comparison means every later release satisfies it no matter how it
 * is numbered, and later same-base dev builds light up; a 0.11.9
 * stable cut without that commit does not.
 *
 * This gates a WRITE path whose new branch withholds a mutation the
 * legacy path still performs, so the check awaits
 * `whenAssistantVersionKnown()` rather than snapshotting the
 * conservative false-on-unknown default. A supplied `ownerAssistantId`
 * must match the hydrated identity; a mismatch gates to the rewrite.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import { assistantSupports, whenAssistantVersionKnown } from "./utils";

export const MIN_VERSION = "0.11.9-dev.202609071544.b018770";

export async function assistantSupportsHostedQwenPersonalitySteering(
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
