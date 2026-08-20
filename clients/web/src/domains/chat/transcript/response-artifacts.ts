/**
 * The assets a response produces (the documents and apps it created, changed,
 * or opened) and how the transcript finds them.
 *
 * An asset announces itself twice: as a mutating tool call, and as a *pointer*
 * surface the tool emits where it ran (a `document_preview`, or a
 * `dynamic_page` carrying `data.preview`, which renders an `AppCard` rather
 * than the expanded live app). The transcript draws neither in place. It
 * collects both into one card per asset at the end of the response, which is
 * what keeps a create-then-edit turn from producing two cards for one asset at
 * two different sizes, and what keeps a pointer surface from splitting the
 * "Earlier activity" run it lands in.
 *
 * A kind is registered here once, and the three consumers read the registry
 * rather than naming a tool or a surface type themselves:
 *
 *   - `message-content.ts` drops pointer surfaces while grouping blocks.
 *   - `resolve-response-artifacts.ts` collects a response's assets.
 *   - `response-artifact-card.tsx` renders each one's card.
 *
 * Pure: no React/DOM, so `message-content.ts` can import it without pulling a
 * component graph into the projection path.
 */

import {
  APP_MUTATION_TOOL_NAMES,
  REOPENABLE_DOCUMENT_MUTATION_TOOL_NAMES,
} from "@vellumai/assistant-api";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

/** The asset kinds a response can close with. */
export type ResponseArtifactKind = "document" | "app";

/** One asset a response touched. */
export interface ResponseArtifact {
  kind: ResponseArtifactKind;
  /** A document's `surfaceId`, or an app's id. */
  id: string;
}

/**
 * The shape both the wire (`ConversationSurfaceBlock["surface"]`) and the
 * display (`Surface`) surfaces satisfy. The registry reads only these two
 * fields, so it can be applied on either side of the narrowing without a cast.
 */
export interface ArtifactSurfaceView {
  surfaceType?: string;
  data?: Record<string, unknown> | null;
}

/** A non-empty trimmed string, or `null`. */
function str(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The app a `dynamic_page` names. Exported because the surface component reads
 * the same two spellings (the daemon has emitted both `appId` and `app_id`),
 * and a second implementation would drift from this one.
 */
export function readDynamicPageAppId(
  surface: Pick<ArtifactSurfaceView, "data">,
): string | null {
  return str(surface.data?.appId) ?? str(surface.data?.app_id);
}

/**
 * Detect a call to one of `tools`. Both asset families ship as bundled skills
 * (`document-editor`, `app-builder`), so a call arrives either under its raw
 * tool name or inside a `skill_execute` envelope whose `input.tool` names it.
 */
function isToolCallNamed(
  toolCall: ChatMessageToolCall,
  tools: ReadonlySet<string>,
): boolean {
  if (tools.has(toolCall.name)) {
    return true;
  }
  if (toolCall.name !== "skill_execute") {
    return false;
  }
  const input = toolCall.input;
  if (input == null || typeof input !== "object") {
    return false;
  }
  const tool = (input as Record<string, unknown>).tool;
  return typeof tool === "string" && tools.has(tool);
}

/** A settled, non-errored call's parsed JSON result, or `null`. */
function parsedResult(
  toolCall: ChatMessageToolCall,
): Record<string, unknown> | null {
  if (toolCall.isError === true) {
    return null;
  }
  if (typeof toolCall.result !== "string" || !toolCall.result) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(toolCall.result);
    return parsed != null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface ArtifactKindSpec {
  kind: ResponseArtifactKind;
  /**
   * The asset `surface` points at, or `null` when the surface is content
   * rather than a pointer. Content surfaces stay where they landed; only
   * pointers are collected into an end-of-response card.
   */
  pointerTarget(surface: ArtifactSurfaceView): string | null;
  /** The asset `toolCall` produced, or `null` when it produced none. */
  idFromToolCall(toolCall: ChatMessageToolCall): string | null;
}

const DOCUMENT_TOOLS: ReadonlySet<string> = new Set(
  REOPENABLE_DOCUMENT_MUTATION_TOOL_NAMES,
);
const APP_TOOLS: ReadonlySet<string> = new Set(APP_MUTATION_TOOL_NAMES);

const DOCUMENT_KIND: ArtifactKindSpec = {
  kind: "document",
  // The card's own `surfaceId` is `preview-<doc id>`; the document it opens
  // rides in `data.surfaceId`, which is also what a document tool reports.
  pointerTarget: (surface) =>
    surface.surfaceType === "document_preview"
      ? str(surface.data?.surfaceId)
      : null,
  idFromToolCall: (toolCall) => {
    if (!isToolCallNamed(toolCall, DOCUMENT_TOOLS)) {
      return null;
    }
    const parsed = parsedResult(toolCall);
    // `document_replace_text` reports whether it matched anything; a replace
    // that changed nothing did not touch the document. `document_create` and
    // `document_update` omit the field and always write, so an absent field
    // reads as changed and only an explicit `false` rejects the call. That
    // matches the daemon, which emits `document_editor_update` on the same
    // condition.
    if (!parsed || parsed.content_changed === false) {
      return null;
    }
    return str(parsed.surface_id);
  },
};

const APP_KIND: ArtifactKindSpec = {
  kind: "app",
  // `dynamic_page` is a pointer only when it carries `preview`: that is the
  // payload `dynamic-page-surface.tsx` renders as an `AppCard`. Without it the
  // surface is the expanded, interactive app itself: content, which belongs
  // where it landed.
  pointerTarget: (surface) =>
    surface.surfaceType === "dynamic_page" && surface.data?.preview != null
      ? readDynamicPageAppId(surface)
      : null,
  idFromToolCall: (toolCall) => {
    if (!isToolCallNamed(toolCall, APP_TOOLS)) {
      return null;
    }
    const parsed = parsedResult(toolCall);
    if (!parsed) {
      return null;
    }
    // `app_create` spreads the app record, so its id is `id`; `app_update`
    // reports `appId`. Both spellings are read rather than normalized daemon
    // side, because older persisted results carry whichever their tool wrote.
    return str(parsed.appId) ?? str(parsed.id);
  },
};

export const ARTIFACT_KINDS: readonly ArtifactKindSpec[] = [
  DOCUMENT_KIND,
  APP_KIND,
];

/**
 * Whether `surface` is a pointer to an asset the response closes with, and so
 * must not render where it landed. Read by `groupContentBlocks`.
 */
export function isArtifactPointerSurface(
  surface: ArtifactSurfaceView,
): boolean {
  return ARTIFACT_KINDS.some((spec) => spec.pointerTarget(surface) !== null);
}

/**
 * The asset `surface` points at, with its kind, or `null` when it is content.
 */
export function artifactFromSurface(
  surface: ArtifactSurfaceView,
): ResponseArtifact | null {
  for (const spec of ARTIFACT_KINDS) {
    const id = spec.pointerTarget(surface);
    if (id !== null) {
      return { kind: spec.kind, id };
    }
  }
  return null;
}

/**
 * The assets `toolCalls` produced, in call order, skipping any already in
 * `seen` and adding what it returns to it.
 *
 * The caller owns `seen` so it spans a whole response: that collapses repeated
 * edits of one asset into a single entry, whether they ran in one message or
 * across several.
 */
export function artifactsFromToolCalls(
  toolCalls: ChatMessageToolCall[],
  seen: Set<string>,
): ResponseArtifact[] {
  const artifacts: ResponseArtifact[] = [];

  for (const toolCall of toolCalls) {
    for (const spec of ARTIFACT_KINDS) {
      const id = spec.idFromToolCall(toolCall);
      if (id === null) {
        continue;
      }
      const key = `${spec.kind}:${id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      artifacts.push({ kind: spec.kind, id });
    }
  }

  return artifacts;
}

/** The dedupe key for one artifact, shared by every collector above. */
export function artifactKey(artifact: ResponseArtifact): string {
  return `${artifact.kind}:${artifact.id}`;
}
