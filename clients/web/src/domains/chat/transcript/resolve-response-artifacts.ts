// Assign the assets a thread touched to the message that ends the response
// that first reached each one, so a thread draws one card per asset rather
// than repeating the same card on every response that writes to it.

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
 * Collapsing across responses is the caller's, since which response keeps the
 * entry is a question about the thread rather than about any one response.
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

/**
 * The anchor each asset's card was awarded to, for the conversation currently
 * on screen.
 *
 * The transcript loads its newest page first and prepends older ones, so the
 * first response that touched an asset is not always known when the card is
 * first drawn: an older page can arrive later carrying an earlier touch. An
 * award already made outranks that late arrival, because retracting a card
 * removes height from below the viewport, which the prepend's scroll
 * correction (a `scrollHeight` delta, see `use-transcript-scroll.ts`) reads as
 * prepended content and compensates for twice.
 *
 * One conversation at a time: switching conversations starts a fresh window
 * (its own newest page) and so a fresh set of awards.
 */
let awardedAnchors: {
  conversationId: string;
  byArtifact: Map<string, string>;
} | null = null;

/**
 * Forget every award.
 *
 * For tests. Nothing in the app needs it: awards are keyed by conversation, a
 * message id belongs to one response for the life of that conversation, and an
 * award naming a response no longer in the window is released on the next
 * resolution. A test suite reusing ids like `a1` across cases has none of those
 * guarantees, so it resets between them instead.
 */
export function resetResponseArtifactAwards(): void {
  awardedAnchors = null;
}

/**
 * The award map for `conversationId`, or `null` when the caller named no
 * conversation and every resolution stands on its own.
 */
function awardsFor(
  conversationId: string | null | undefined,
): Map<string, string> | null {
  if (conversationId == null) {
    return null;
  }
  if (awardedAnchors?.conversationId !== conversationId) {
    awardedAnchors = { conversationId, byArtifact: new Map() };
  }
  return awardedAnchors.byArtifact;
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
  /**
   * The conversation being resolved, which scopes the awards that survive an
   * older-page prepend. Omitted, every resolution stands on its own.
   */
  conversationId?: string | null;
}

/** One response's assets, and the message that can draw them. */
interface DrawableResponse {
  anchor: MessageItem;
  artifacts: ResponseArtifact[];
}

/**
 * The responses that could draw a card, oldest first, each with the assets it
 * touched.
 *
 * A response that cannot draw is left out rather than recorded as empty: the
 * in-flight one, which is withheld until the turn settles, and one whose every
 * message is a system card, which has no card slot. Neither claims an asset,
 * so the next response to touch it still closes with the card.
 */
function drawableResponses(
  items: TranscriptItem[],
  turnActive: boolean,
): DrawableResponse[] {
  const responses = splitResponses(items);
  const inFlightIndex = turnActive ? responses.length - 1 : -1;
  const drawable: DrawableResponse[] = [];

  responses.forEach((response, index) => {
    if (index === inFlightIndex) {
      return;
    }
    const anchor = response.findLast(canAnchorCards);
    if (!anchor) {
      return;
    }
    const artifacts = touchedArtifacts(response);
    if (artifacts.length > 0) {
      drawable.push({ anchor, artifacts });
    }
  });

  return drawable;
}

/**
 * The anchor that draws each asset's card: the oldest response that touched it,
 * unless a card was already awarded to a response still present in this window,
 * which keeps it.
 *
 * Recorded as it is decided, so the next resolution (one more page of history,
 * one more settled turn) reaches the same answer for an asset already drawn.
 */
function anchorPerArtifact(
  drawable: DrawableResponse[],
  awards: Map<string, string> | null,
): Map<string, string> {
  const occurrences = new Map<string, string[]>();

  for (const { anchor, artifacts } of drawable) {
    for (const artifact of artifacts) {
      const key = artifactKey(artifact);
      const anchors = occurrences.get(key);
      if (anchors) {
        anchors.push(anchor.key);
      } else {
        occurrences.set(key, [anchor.key]);
      }
    }
  }

  const chosen = new Map<string, string>();
  for (const [key, anchors] of occurrences) {
    // An award whose response has left the window (a fork, a cleared history)
    // names an anchor nothing can draw, so the oldest touch takes it back.
    const held = awards?.get(key);
    const anchorKey =
      held != null && anchors.includes(held) ? held : anchors[0]!;
    chosen.set(key, anchorKey);
    awards?.set(key, anchorKey);
  }

  return chosen;
}

/**
 * The assets each response closes with, keyed by the transcript item key of the
 * message that ends that response.
 *
 * An asset earns one card in a thread, on the response that first reached it.
 * Every later response that writes to, or reopens, the same asset draws
 * nothing: it is in the conversation's assets by then (the header pill lists
 * it, and a changed document lights its dot), so a second card would be a
 * second way to say what the pill already says.
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
  const drawable = drawableResponses(items, options?.turnActive === true);
  const anchorKeys = anchorPerArtifact(
    drawable,
    awardsFor(options?.conversationId),
  );

  // Walked in response order, so a response closing with more than one asset
  // keeps them in the order it touched them.
  const collected = new Map<string, ResponseArtifact[]>();
  for (const { anchor, artifacts } of drawable) {
    for (const artifact of artifacts) {
      if (anchorKeys.get(artifactKey(artifact)) !== anchor.key) {
        continue;
      }
      const drawn = collected.get(anchor.key);
      if (drawn) {
        drawn.push(artifact);
      } else {
        collected.set(anchor.key, [artifact]);
      }
    }
  }

  const byItemKey = new Map<string, ResponseArtifact[]>();
  for (const { anchor } of drawable) {
    const artifacts = collected.get(anchor.key);
    if (artifacts) {
      byItemKey.set(anchor.key, stableArtifacts(anchor.message, artifacts));
    }
  }

  return byItemKey;
}
