/**
 * Backwards-compat gate: vision attachment filtering.
 *
 * Vellum Assistant 0.10.0 removed the client-side vision gate that
 * blocked image attachments on text-only models. The image-fallback
 * plugin (shipped in 0.10.0) now handles image captioning server-side,
 * so the web client no longer needs to pre-filter images for
 * non-vision models — all file types can be attached to any model.
 *
 * Assistants on 0.9.x or older have no image-fallback plugin. The
 * drop/pick handler still filters out images when the active model
 * lacks vision support, preserving the old behavior.
 *
 * Dev release versions (e.g. `0.10.0-dev.202606211252.5cf8576`) are
 * treated as `0.10.0` by the semver pre-release stripping in
 * `useAssistantSupports`, so dev builds get the new behavior.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.0";

/**
 * Returns `true` when the web client should filter image attachments
 * for non-vision models. Active for assistants older than 0.10.0;
 * inactive for 0.10.0+ (including dev pre-releases).
 */
export function useVisionAttachmentGate(): boolean {
  return !useAssistantSupports(MIN_VERSION);
}
