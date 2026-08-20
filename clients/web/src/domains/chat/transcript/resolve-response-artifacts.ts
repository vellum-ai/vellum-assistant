// Assign the assets a response touched to the message that ends it, so a
// response closes with one card per asset rather than repeating the same card
// on every message that wrote to it.

import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import {
  artifactFromSurface,
  artifactKey,
  artifactsFromToolCalls,
  type ResponseArtifact,
} from "@/domains/chat/transcript/response-artifacts";

/**
 * Split `items` into responses on the same boundary `partitionLatestTurn`
 * uses: every user message opens a new one. Assistant messages before the
 * first user message form the leading response, and the trailing entry is the
 * response to the newest user message, empty until it produces a message.
 *
 * Non-message items (the thinking slot, pending prompts, ephemeral meta) carry
 * no tool calls and no card slot, so they are skipped rather than split on.
 */
function splitResponses(items: TranscriptItem[]): MessageItem[][] {
  const responses: MessageItem[][] = [[]];

  for (const item of items) {
    if (item.kind !== "message") {
      continue;
    }
    if (item.message.role === "user") {
      responses.push([]);
      continue;
    }
    responses[responses.length - 1]!.push(item);
  }

  return responses;
}

/** The assets `message` announced with an inline pointer surface. */
function pointedArtifacts(message: DisplayMessage): ResponseArtifact[] {
  const artifacts: ResponseArtifact[] = [];

  for (const block of message.contentBlocks ?? []) {
    if (block.type !== "surface") {
      continue;
    }
    const artifact = artifactFromSurface(block.surface);
    if (artifact) {
      artifacts.push(artifact);
    }
  }

  return artifacts;
}

/**
 * The assets `response` touched, in first-touched order.
 *
 * Both the ways an asset reaches a response count, because the transcript draws
 * neither of them where it happened: a mutating tool call, and an inline
 * pointer surface, which is how an open with no write announces itself. Taking
 * the union means one card per asset however the response reached it, where
 * subtracting one from the other produced a card mid-transcript for a create, a
 * second one at the end as soon as an edit followed, and none at all for a bare
 * open.
 *
 * The seen set spans the whole response, so repeated edits of one asset
 * collapse into a single entry, whether they ran in one message or several.
 */
function touchedArtifacts(response: MessageItem[]): ResponseArtifact[] {
  const seen = new Set<string>();
  const artifacts: ResponseArtifact[] = [];

  for (const item of response) {
    // `artifactsFromToolCalls` both filters on and adds to `seen`.
    artifacts.push(
      ...artifactsFromToolCalls(item.message.toolCalls ?? [], seen),
    );
    for (const artifact of pointedArtifacts(item.message)) {
      const key = artifactKey(artifact);
      if (!seen.has(key)) {
        seen.add(key);
        artifacts.push(artifact);
      }
    }
  }

  return artifacts;
}

/**
 * Whether `item` can carry its response's asset cards. System cards render
 * through `SystemCardRow`, which has no card slot, so a response that ends on
 * one anchors its cards on the last ordinary message instead.
 */
function canAnchorCards(item: MessageItem): boolean {
  return !item.message.isSystemCard;
}

/** Previously returned artifacts, keyed by the message that anchored them. */
const artifactsByAnchor = new WeakMap<DisplayMessage, ResponseArtifact[]>();

/**
 * Reuse the previous array for an anchor whose assets are unchanged, so the row
 * carrying the cards keeps its `memo()` across the re-render every streaming
 * token triggers.
 */
function stableArtifacts(
  anchor: DisplayMessage,
  artifacts: ResponseArtifact[],
): ResponseArtifact[] {
  const cached = artifactsByAnchor.get(anchor);
  if (
    cached &&
    cached.length === artifacts.length &&
    cached.every(
      (artifact, i) =>
        artifact.kind === artifacts[i]!.kind &&
        artifact.id === artifacts[i]!.id,
    )
  ) {
    return cached;
  }
  artifactsByAnchor.set(anchor, artifacts);
  return artifacts;
}

export interface ResolveResponseArtifactsOptions {
  /**
   * Whether a turn is in flight. The trailing response is the one being
   * generated, so it is left out until the turn settles and its closing
   * affordance is honest.
   */
  turnActive?: boolean;
}

/**
 * The assets each completed response touched, keyed by the transcript item key
 * of the message that ends that response.
 *
 * Each id rides on its tool call's persisted `result` or its pointer surface's
 * persisted block, so a response reseeded from `/messages` resolves the same
 * assets as the streamed one.
 *
 * Rows read their own entry, so every row without assets keeps a stable
 * `undefined` and every row with them keeps a stable array.
 */
export function resolveResponseArtifacts(
  items: TranscriptItem[],
  options?: ResolveResponseArtifactsOptions,
): Map<string, ResponseArtifact[]> {
  const byItemKey = new Map<string, ResponseArtifact[]>();
  const responses = splitResponses(items);
  const inFlightIndex = options?.turnActive ? responses.length - 1 : -1;

  responses.forEach((response, index) => {
    if (index === inFlightIndex) {
      return;
    }
    const anchor = response.findLast(canAnchorCards);
    if (!anchor) {
      return;
    }
    const artifacts = touchedArtifacts(response);
    if (artifacts.length === 0) {
      return;
    }
    byItemKey.set(anchor.key, stableArtifacts(anchor.message, artifacts));
  });

  return byItemKey;
}
