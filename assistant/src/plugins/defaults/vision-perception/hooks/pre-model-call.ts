/**
 * `pre-model-call` gating for vision perception.
 *
 * Vision perception only engages for backbones that lack native image/video
 * support. The gate is evaluated per turn against the *resolved* model:
 *
 * - **Vision-capable backbone:** the feature is fully inert. The `vlm_*` tools
 *   are removed from the offered tool list (see {@link VLM_TOOL_NAMES}, gated in
 *   `daemon/conversation-tool-setup.ts`) and media blocks pass through to the
 *   model unchanged.
 * - **Non-vision backbone:** an uploaded image must never reach the model as raw
 *   bytes. Each media block on the outbound request is replaced with a text
 *   marker that names the attachment id, so the model can read it by calling a
 *   `vlm_*` tool with `media_ref="<id>"`. The `vlm_*` tools stay offered.
 *
 * The runtime `PreModelCallContext` carries neither the outbound message list
 * nor the offered tools, so the two mutations are driven from the per-turn paths
 * that do: tool gating in `conversation-tool-setup.ts`, and the media-marker
 * rewrite in the agent loop's outbound-request sanitization, both keyed on
 * {@link resolveBackboneSupportsVision}. This module is the single home for the
 * gating predicate, the marker rendering, and the `vlm_*` tool-name set; the
 * default export is the registered hook, which self-gates and leaves the request
 * untouched (its context cannot reach messages or tools today).
 */

import type { PluginHookFn, PreModelCallContext } from "@vellumai/plugin-api";

import { isAssistantFeatureFlagEnabled } from "../../../../config/assistant-feature-flags.js";
import { resolveCallSiteConfig } from "../../../../config/llm-resolver.js";
import { getConfig } from "../../../../config/loader.js";
import type { LLMCallSite } from "../../../../config/schemas/llm.js";
import { getAttachmentById } from "../../../../memory/attachments-store.js";
import { PROVIDER_CATALOG } from "../../../../providers/model-catalog.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
} from "../../../../providers/types.js";

/**
 * Names of the model-visible vision tools the plugin contributes. Kept here so
 * the offered-tool gate (which omits them for vision-capable backbones) and the
 * media marker (which names them as the way to inspect an attachment) share one
 * source of truth, independent of which subset of tools is currently
 * registered.
 */
export const VLM_TOOL_NAMES: ReadonlySet<string> = new Set([
  "vlm_ask",
  "vlm_describe",
  "vlm_ocr",
  "vlm_detect",
]);

/** Whether `name` is one of the plugin's vision tools. */
export function isVlmToolName(name: string): boolean {
  return VLM_TOOL_NAMES.has(name);
}

/**
 * Resolve whether the backbone that will serve a turn natively supports vision.
 *
 * Resolves the call site's effective provider/model the same way the dispatch
 * path does (via {@link resolveCallSiteConfig}) and reads `supportsVision` from
 * the model catalog. Unknown (provider, model) pairs fail open to `true` —
 * matching `GET /v1/config`'s per-profile enrichment — so custom or unlisted
 * models keep native image handling and the feature stays inert for them.
 *
 * Returns `true` (feature inert) whenever the `vision-perception` flag is off,
 * so callers gate uniformly on this one predicate: a vision-capable result means
 * "leave media intact and don't offer the vlm_* tools".
 */
export function resolveBackboneSupportsVision(opts: {
  callSite: LLMCallSite | null;
  overrideProfile: string | null;
  selectionSeed?: string | null;
}): boolean {
  try {
    const config = getConfig();
    if (!isAssistantFeatureFlagEnabled("vision-perception", config)) {
      return true;
    }
    const { llm } = config;
    const resolved = resolveCallSiteConfig(opts.callSite ?? "mainAgent", llm, {
      ...(opts.overrideProfile
        ? { overrideProfile: opts.overrideProfile }
        : {}),
      ...(opts.selectionSeed ? { selectionSeed: opts.selectionSeed } : {}),
    });
    const catalogProvider = PROVIDER_CATALOG.find(
      (p) => p.id === resolved.provider,
    );
    const catalogModel = catalogProvider?.models.find(
      (m) => m.id === resolved.model,
    );
    return catalogModel?.supportsVision ?? true;
  } catch {
    // Fail open: never let a resolution error strip media from a request.
    return true;
  }
}

/** Human-readable media kind for the marker text. */
function mediaKind(block: ImageContent): string {
  return block.source.media_type.startsWith("video/") ? "Video" : "Image";
}

/** Best-effort original filename for an attachment id; falls back to a generic label. */
function resolveAttachmentFilename(attachmentId: string): string {
  try {
    return getAttachmentById(attachmentId)?.originalFilename ?? "attachment";
  } catch {
    return "attachment";
  }
}

/**
 * Render the text marker that replaces a raw media block for a non-vision
 * backbone. Names the attachment id so the model has a usable `media_ref`.
 */
export function renderMediaMarker(
  attachmentId: string,
  filename: string,
  kind: string,
): string {
  return (
    `[${kind} attachment available — id="${attachmentId}", file "${filename}". ` +
    `You cannot view it directly; call vlm_ask / vlm_describe / vlm_ocr / vlm_detect ` +
    `with media_ref="${attachmentId}" to inspect it.]`
  );
}

/**
 * Replace raw image blocks with attachment-id markers when the backbone lacks
 * native vision. Returns the input array unchanged (same reference) when the
 * backbone is vision-capable or when there is nothing to replace, so a request
 * that needs no rewrite is not copied.
 *
 * Image blocks that carry no `_attachmentId` (e.g. tool-generated images) are
 * left intact: without an id there is no `media_ref` the model could pass to a
 * `vlm_*` tool, so dropping them would only lose information.
 */
export function applyVisionPerceptionMarkers(
  messages: Message[],
  supportsVision: boolean,
): Message[] {
  if (supportsVision) return messages;

  const replaceableImage = (block: ContentBlock): block is ImageContent =>
    block.type === "image" && typeof block._attachmentId === "string";

  const hasReplaceable = messages.some((msg) =>
    msg.content.some(replaceableImage),
  );
  if (!hasReplaceable) return messages;

  return messages.map((msg) => {
    if (!msg.content.some(replaceableImage)) return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
        if (!replaceableImage(block)) return block;
        const id = block._attachmentId!;
        return {
          type: "text" as const,
          text: renderMediaMarker(
            id,
            resolveAttachmentFilename(id),
            mediaKind(block),
          ),
        };
      }),
    };
  });
}

/**
 * Registered `pre-model-call` hook. The runtime context exposes only the system
 * prompt, model-profile routing, and deferred-output flag — not the outbound
 * messages or offered tools — so the per-turn paths that own those (tool
 * resolution, outbound sanitization) drive the actual gating. This hook is the
 * forward-compatible registration point and leaves the request untouched.
 */
const preModelCall: PluginHookFn<PreModelCallContext> = async () => {};

export default preModelCall;
