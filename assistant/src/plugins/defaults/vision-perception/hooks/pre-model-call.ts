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

import { resolveCallSiteConfig } from "../../../../config/llm-resolver.js";
import { getConfig } from "../../../../config/loader.js";
import type { LLMCallSite } from "../../../../config/schemas/llm.js";
import { isVisionPerceptionEnabled } from "../../../../config/vision-perception-flag.js";
import { getAttachmentById } from "../../../../memory/attachments-store.js";
import { PROVIDER_CATALOG } from "../../../../providers/model-catalog.js";
import type {
  ContentBlock,
  FileContent,
  ImageContent,
  Message,
} from "../../../../providers/types.js";

/**
 * The model-visible IMAGE-inspection tools the plugin contributes. Gated on the
 * backbone's native *image* vision (`supportsVision`): a backbone that can see
 * images itself reads uploaded images directly, so these are dead weight and
 * omitted for it.
 */
export const VLM_IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "vlm_ask",
  "vlm_describe",
  "vlm_ocr",
  "vlm_detect",
]);

/**
 * The model-visible VIDEO-inspection tool. Gated on native *video* support, not
 * `supportsVision`: an image-vision backbone still cannot process `video/*`
 * (the provider serializers render video files as text placeholders, not native
 * video), so it must keep this tool. No catalog model supports native video
 * through our pipeline today, so it is offered whenever the feature is active —
 * see {@link resolveBackboneSupportsVideo}.
 */
export const VLM_VIDEO_TOOL_NAMES: ReadonlySet<string> = new Set([
  "vlm_video_log",
]);

/**
 * Names of every model-visible vision tool the plugin contributes. Kept here so
 * the offered-tool gate (which omits them per-modality) and the media marker
 * (which names them as the way to inspect an attachment) share one source of
 * truth, independent of which subset of tools is currently registered.
 */
export const VLM_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...VLM_IMAGE_TOOL_NAMES,
  ...VLM_VIDEO_TOOL_NAMES,
]);

/** Whether `name` is one of the plugin's vision tools. */
export function isVlmToolName(name: string): boolean {
  return VLM_TOOL_NAMES.has(name);
}

/** Whether `name` is one of the plugin's IMAGE-inspection tools. */
export function isVlmImageToolName(name: string): boolean {
  return VLM_IMAGE_TOOL_NAMES.has(name);
}

/** Whether `name` is the plugin's VIDEO-inspection tool. */
export function isVlmVideoToolName(name: string): boolean {
  return VLM_VIDEO_TOOL_NAMES.has(name);
}

export interface BackboneResolutionOpts {
  callSite: LLMCallSite | null;
  overrideProfile: string | null;
  selectionSeed?: string | null;
}

/**
 * Resolve the catalog model entry for the backbone that will serve a turn,
 * resolving the call site's effective provider/model the same way the dispatch
 * path does (via {@link resolveCallSiteConfig}). Returns `undefined` for an
 * unknown (provider, model) pair so each caller can pick its own fail-open
 * default per capability.
 */
function resolveBackboneCatalogModel(opts: BackboneResolutionOpts) {
  const config = getConfig();
  const { llm } = config;
  const resolved = resolveCallSiteConfig(opts.callSite ?? "mainAgent", llm, {
    ...(opts.overrideProfile ? { overrideProfile: opts.overrideProfile } : {}),
    ...(opts.selectionSeed ? { selectionSeed: opts.selectionSeed } : {}),
  });
  const catalogProvider = PROVIDER_CATALOG.find(
    (p) => p.id === resolved.provider,
  );
  return catalogProvider?.models.find((m) => m.id === resolved.model);
}

/**
 * Resolve whether the backbone that will serve a turn natively supports IMAGE
 * vision, reading `supportsVision` from the model catalog. Unknown (provider,
 * model) pairs fail open to `true` — matching `GET /v1/config`'s per-profile
 * enrichment — so custom or unlisted models keep native image handling and the
 * feature stays inert for them.
 *
 * Returns `true` (feature inert) whenever the `vision-perception` flag is off,
 * so callers gate uniformly on this one predicate: a vision-capable result means
 * "leave images intact and don't offer the image vlm_* tools".
 */
export function resolveBackboneSupportsVision(
  opts: BackboneResolutionOpts,
): boolean {
  try {
    if (!isVisionPerceptionEnabled(getConfig())) {
      return true;
    }
    return resolveBackboneCatalogModel(opts)?.supportsVision ?? true;
  } catch {
    // Fail open: never let a resolution error strip media from a request.
    return true;
  }
}

/**
 * Resolve whether the backbone that will serve a turn natively supports VIDEO.
 *
 * There is no `supportsVideo` capability in the catalog today and no catalog
 * model can process `video/*` natively through our pipeline (the provider
 * serializers render video files as text placeholders), so this is always
 * `false` while the feature is active: `vlm_video_log` and the video marker
 * stay available even on an image-vision backbone.
 *
 * Returns `true` (feature inert) whenever the `vision-perception` flag is off,
 * mirroring {@link resolveBackboneSupportsVision}.
 *
 * If a natively-video-capable model is ever added, give the catalog a
 * `supportsVideo` field and return it here (fail open to `false` for unknown
 * models, since native video remains the rare case) so the video tool/marker
 * become inert for those backbones exactly as the image path does today.
 */
export function resolveBackboneSupportsVideo(
  // Unused today — kept so callers thread the same resolution opts as the image
  // gate and the extension point (a future `supportsVideo` catalog read) is
  // already wired. See the doc above.
  _opts: BackboneResolutionOpts,
): boolean {
  try {
    // Flag off → inert (mirrors the image gate). With the flag on, no catalog
    // model is natively video-capable, so the video tool/marker stay active.
    return isVisionPerceptionEnabled(getConfig()) ? false : true;
  } catch {
    // A config-read failure leaves the video path active (fail closed toward
    // "the model can't read video natively"), matching the marker rewrite's
    // intent that raw video never silently reach a model that can't read it.
    return false;
  }
}

/** Human-readable media kind for the marker text. */
function mediaKind(block: ImageContent): "Image" | "Video" {
  return block.source.media_type.startsWith("video/") ? "Video" : "Image";
}

/**
 * Whether a `file` block carries a video the model can't read inline. Inline
 * uploads of `video/*` reach the model as a {@link FileContent} block (only
 * `image/*` becomes an {@link ImageContent} — see `agent/attachments.ts`), so a
 * non-vision backbone needs that block rewritten into a `vlm_video_log` marker
 * too. Detected by the block's own `media_type` first (no DB hit), falling back
 * to the attachment row's `kind` for blocks whose declared MIME is generic.
 */
function isVideoFileBlock(block: FileContent): boolean {
  if (block.source.media_type.toLowerCase().startsWith("video/")) return true;
  const id = block._attachmentId;
  if (typeof id !== "string") return false;
  try {
    return getAttachmentById(id)?.kind === "video";
  } catch {
    return false;
  }
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
 * backbone. Names the attachment id so the model has a usable `media_ref`, and
 * advertises the right tool for the media kind: `vlm_video_log` for videos, the
 * image inspection tools otherwise.
 */
export function renderMediaMarker(
  attachmentId: string,
  filename: string,
  kind: string,
): string {
  const tools =
    kind === "Video"
      ? `call vlm_video_log with media_ref="${attachmentId}" to read it`
      : `call vlm_ask / vlm_describe / vlm_ocr / vlm_detect ` +
        `with media_ref="${attachmentId}" to inspect it`;
  return (
    `[${kind} attachment available — id="${attachmentId}", file "${filename}". ` +
    `You cannot view it directly; ${tools}.]`
  );
}

/**
 * Per-modality gating for the marker rewrite. A modality's media is replaced
 * with an attachment-id marker only when the backbone CANNOT process that
 * modality natively, so an image-vision backbone (image native, video not) gets
 * raw images through but a video marker for any uploaded video.
 */
export interface VisionPerceptionModalitySupport {
  /** The backbone natively reads IMAGES (`supportsVision`). */
  supportsVision: boolean;
  /** The backbone natively reads VIDEO (always `false` today — see
   * {@link resolveBackboneSupportsVideo}). */
  supportsVideo: boolean;
}

/**
 * Replace raw media blocks with attachment-id markers, PER MODALITY, when the
 * backbone lacks native support for that modality. Returns the input array
 * unchanged (same reference) when nothing needs replacing, so a request that
 * needs no rewrite is not copied.
 *
 * Modalities are gated independently:
 *  - IMAGE media (an `image` block with an `image/*` media_type) is replaced
 *    only when `supportsVision` is false.
 *  - VIDEO media (a `file` block carrying a video — see {@link isVideoFileBlock}
 *    — or, defensively, an `image` block with a `video/*` media_type) is
 *    replaced only when `supportsVideo` is false. An image-vision backbone still
 *    cannot process `video/*` natively (the provider serializers render it as a
 *    text placeholder), so the video still becomes a `vlm_video_log` marker even
 *    though images pass through.
 *
 * Non-video `file` blocks (PDFs, documents, …) are left intact — the backbone
 * can read their `extracted_text`, and there is no `vlm_*` tool for them.
 *
 * Blocks that carry no `_attachmentId` (e.g. tool-generated images) are left
 * intact: without an id there is no `media_ref` the model could pass to a
 * `vlm_*` tool, so dropping them would only lose information.
 */
export function applyVisionPerceptionMarkers(
  messages: Message[],
  support: VisionPerceptionModalitySupport,
): Message[] {
  const { supportsVision, supportsVideo } = support;
  // Both modalities native → feature fully inert, nothing to rewrite.
  if (supportsVision && supportsVideo) return messages;

  // Classify a block's modality (or null when it is not replaceable media).
  const modalityOf = (block: ContentBlock): "Image" | "Video" | null => {
    if (block.type === "image") {
      if (typeof block._attachmentId !== "string") return null;
      return mediaKind(block); // "Image" or "Video" (defensive video/* image)
    }
    if (block.type === "file") {
      if (typeof block._attachmentId !== "string") return null;
      return isVideoFileBlock(block) ? "Video" : null;
    }
    return null;
  };

  // A block is replaced only when its modality is NOT natively supported.
  const replaceableKind = (block: ContentBlock): "Image" | "Video" | null => {
    const modality = modalityOf(block);
    if (modality === "Image") return supportsVision ? null : "Image";
    if (modality === "Video") return supportsVideo ? null : "Video";
    return null;
  };

  const hasReplaceable = messages.some((msg) =>
    msg.content.some((b) => replaceableKind(b) !== null),
  );
  if (!hasReplaceable) return messages;

  return messages.map((msg) => {
    if (!msg.content.some((b) => replaceableKind(b) !== null)) return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
        const kind = replaceableKind(block);
        if (kind === null) return block;
        const id = (block as ImageContent | FileContent)._attachmentId!;
        return {
          type: "text" as const,
          text: renderMediaMarker(id, resolveAttachmentFilename(id), kind),
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
