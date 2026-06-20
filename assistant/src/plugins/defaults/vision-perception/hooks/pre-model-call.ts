/**
 * `pre-model-call` gating for vision perception.
 *
 * This entire feature is a crutch for a text-only backbone (today the only such
 * catalog model is GLM 5.2, `supportsVision: false`). It engages on a SINGLE
 * capability gate — the resolved backbone's `supportsVision` — and is fully inert
 * for every vision-capable model. The gate is evaluated per turn against the
 * *resolved* model:
 *
 * - **Vision-capable backbone (`supportsVision === true`):** the feature is fully
 *   inert. The `vlm_*` tools are removed from the offered tool list (see
 *   {@link VLM_TOOL_NAMES}, gated in `daemon/conversation-tool-setup.ts`) and ALL
 *   media blocks (image and video) pass through to the model unchanged.
 * - **Text-only backbone (`supportsVision === false`):** an uploaded image/video
 *   must never reach the model as raw bytes. Each media block on the outbound
 *   request is replaced with a text marker that names the attachment id, so the
 *   model can read it by calling a `vlm_*` tool with `media_ref="<id>"`. The
 *   `vlm_*` tools stay offered.
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
 * Names of every model-visible vision tool the plugin contributes. Kept here so
 * the offered-tool gate (which omits them all when the backbone sees natively)
 * and the media marker (which names them as the way to inspect an attachment)
 * share one source of truth. ALL of these gate together on the single
 * `supportsVision` capability — there is no per-modality (image vs video) split:
 * the feature is offered as a whole for a text-only backbone and withheld as a
 * whole for a vision-capable one.
 */
export const VLM_TOOL_NAMES: ReadonlySet<string> = new Set([
  "vlm_ask",
  "vlm_describe",
  "vlm_ocr",
  "vlm_detect",
  "vlm_video_log",
]);

/** Whether `name` is one of the plugin's vision tools. */
export function isVlmToolName(name: string): boolean {
  return VLM_TOOL_NAMES.has(name);
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
 * Resolve whether the backbone that will serve a turn natively supports vision,
 * reading `supportsVision` from the model catalog. Unknown (provider, model)
 * pairs fail open to `true` — matching `GET /v1/config`'s per-profile enrichment
 * — so custom or unlisted models keep native media handling and the feature
 * stays inert for them.
 *
 * Returns `true` (feature inert) whenever the `vision-perception` flag is off,
 * so callers gate uniformly on this one predicate: a vision-capable result means
 * "leave media intact and don't offer the vlm_* tools".
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

/** Human-readable media kind for the marker text. */
function mediaKind(block: ImageContent): "Image" | "Video" {
  return block.source.media_type.startsWith("video/") ? "Video" : "Image";
}

/**
 * Whether a `file` block carries a video the model can't read inline. Inline
 * uploads of `video/*` reach the model as a {@link FileContent} block (only
 * `image/*` becomes an {@link ImageContent} — see `agent/attachments.ts`), so a
 * text-only backbone needs that block rewritten into a `vlm_video_log` marker
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
 * Render the text marker that replaces a raw media block for a text-only
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
 * Replace raw media blocks (images AND videos) with attachment-id markers when
 * the backbone cannot see media natively. Returns the input array unchanged
 * (same reference) when nothing needs replacing, so a request that needs no
 * rewrite is not copied.
 *
 * Single gate: `supportsVision === true` → fully inert, every media block passes
 * through. `supportsVision === false` → both image media (an `image` block) and
 * video media (a `file` block carrying a video — see {@link isVideoFileBlock} —
 * or, defensively, an `image` block with a `video/*` media_type) become markers.
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
  supportsVision: boolean,
): Message[] {
  // Vision-capable backbone → feature fully inert, nothing to rewrite.
  if (supportsVision) return messages;

  // A block is replaced (with the marker for its media kind) only when it is
  // replaceable media carrying an attachment id.
  const replaceableKind = (block: ContentBlock): "Image" | "Video" | null => {
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
