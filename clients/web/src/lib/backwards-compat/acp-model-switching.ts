/**
 * Backwards-compat gate: choosing the model an ACP coding-agent session runs.
 *
 * The feature adds three daemon-side surfaces at once, and neither of the two
 * web surfaces it feeds can be offered without all three: the live switch
 * `POST /v1/assistants/{assistant_id}/acp/{id}/set-model`, the
 * `acp.defaultModel` config key applied at spawn, and the `model` /
 * `availableModels` fields on `GET /v1/acp/sessions` that a picker lists and
 * checks against.
 *
 * Only the route fails loudly on an older assistant. The config key fails the
 * quiet way this registry warns about: `PATCH /v1/config` is raw passthrough,
 * so the write answers 200 and lands in the file, while `AcpConfigSchema`
 * strips the unknown key on every read. The setting would look saved and never
 * reach a spawn. The listing is quiet too, reporting no model at all rather
 * than refusing.
 *
 * - Old behavior (< MIN_VERSION): the Coding Agents settings card and the
 *   MODEL card in the ACP run panel render nothing, so a session runs on
 *   whatever the adapter picks, as every session did before.
 * - New behavior (>= MIN_VERSION): both surfaces render, the card saves
 *   `acp.defaultModel`, and the panel switches a running session's model.
 *
 * MIN_VERSION is a dev floor rather than a predicted release number, per
 * `docs/BACKWARDS_COMPAT.md`. It names this feature branch's last daemon
 * commit, the one that added the route and the listing fields, on top of the
 * then-current base `0.11.10`. Re-stamp it only if unrelated dev builds could
 * be cut from main between this stamp and the branch's squash-merge into main,
 * since such a build would pass the floor while carrying none of the three.
 */
import {
  useAssistantScopedSupports,
  useAssistantSupports,
} from "@/lib/backwards-compat/utils";

export const MIN_VERSION = "0.11.10-dev.202609090534.a9ef179";

/** Gates surfaces that follow whichever assistant is active. */
export function useSupportsAcpModelSwitching(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

/**
 * Returns `true` only when the version the identity store holds was fetched
 * for `assistantId`, the assistant the gated surface reads and writes.
 *
 * During an assistant switch the active id changes before the identity store
 * catches up, so the unscoped gate can answer off the outgoing assistant's
 * version. On an older newly selected assistant that lights the card, and a
 * quick save writes an `acp.defaultModel` its config schema strips. Scoping
 * holds the surface closed until the version hydrates for the assistant it
 * belongs to.
 */
export function useAssistantScopedSupportsAcpModelSwitching(
  assistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, assistantId);
}
