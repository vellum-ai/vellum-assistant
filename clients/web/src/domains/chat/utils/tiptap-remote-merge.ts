/**
 * Merges a document body that arrives from outside the editor (an assistant
 * edit streamed over SSE) into the live editor without replacing it.
 *
 * The tracker keeps a few anchors: documents the server is known to have held,
 * each paired with a Mapping from that document to the editor's current one.
 * An incoming body is diffed against the anchor it differs from least, which
 * is taken as its ancestor. The difference is split into hunks, each hunk is
 * mapped through the local changes made since that anchor, and the mapped
 * hunks are applied as one transaction kept out of undo history.
 *
 * A hunk whose anchor range the user has changed since is a conflict: the
 * user's text is kept, the hunk is skipped, and the result says so. Hunks
 * elsewhere still apply.
 *
 * Anchors:
 * - `remote`: the last body received from outside. Streamed appends are
 *   concatenated onto this body by the viewer store, so it is always a
 *   candidate.
 * - `sent`: the most recent bodies the save path wrote. The assistant reads
 *   the server's copy, so a replacement body usually descends from one of
 *   these.
 *
 * References:
 * - https://prosemirror.net/docs/ref/#model.Fragment.findDiffStart
 * - https://prosemirror.net/docs/ref/#transform.Mapping
 * - prosemirror-collab's `rebaseSteps`, which pairs inverted and re-applied
 *   step maps as mirrors the same way `rebasedMapping` does here.
 */

import type { Editor } from "@tiptap/core";
import { createDocument } from "@tiptap/core";
import type { Fragment, Node as PmNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { PluginKey } from "@tiptap/pm/state";
import {
  Mapping,
  ReplaceStep,
  replaceStep,
  type Step,
  Transform,
} from "@tiptap/pm/transform";

// ---------------------------------------------------------------------------
// Markdown <-> document
// ---------------------------------------------------------------------------

interface MarkdownCodec {
  parser: { parse: (markdown: string) => string };
  serializer: { serialize: (doc: PmNode) => string };
}

function markdownCodec(editor: Editor): MarkdownCodec {
  return (editor.storage as unknown as { markdown: MarkdownCodec }).markdown;
}

/** Parses markdown the same way the editor parses its initial content. */
export function parseEditorMarkdown(editor: Editor, markdown: string): PmNode {
  return createDocument(
    markdownCodec(editor).parser.parse(markdown),
    editor.schema,
    editor.options.parseOptions,
  );
}

export function serializeEditorDoc(editor: Editor, doc: PmNode): string {
  return markdownCodec(editor).serializer.serialize(doc);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** A changed range: `[fromA, toA)` in the old doc becomes `[fromB, toB)` of the new. */
export interface Hunk {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** Above this many cell comparisons the changed blocks are one hunk. */
const MAX_LCS_CELLS = 250_000;

function childOffsets(fragment: Fragment): number[] {
  const offsets = [0];
  fragment.forEach((child) => {
    offsets.push(offsets[offsets.length - 1]! + child.nodeSize);
  });
  return offsets;
}

/** Narrows a changed range to the positions that actually differ. */
function refineHunk(
  a: PmNode,
  b: PmNode,
  fromA: number,
  toA: number,
  fromB: number,
  toB: number,
): Hunk | null {
  const partA = a.content.cut(fromA, toA);
  const partB = b.content.cut(fromB, toB);
  const start = partA.findDiffStart(partB);
  if (start === null) {
    return null;
  }
  const end = partA.findDiffEnd(partB);
  let endA = end?.a ?? partA.size;
  let endB = end?.b ?? partB.size;
  // Repeated content can make the end scan pass the start scan.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return {
    fromA: fromA + start,
    toA: fromA + endA,
    fromB: fromB + start,
    toB: fromB + endB,
  };
}

/**
 * Hunks turning `a` into `b`, in ascending order. Top-level blocks are
 * aligned by a longest common subsequence so separate edits stay separate,
 * then each run of changed blocks narrows to its differing positions.
 */
export function diffDocs(a: PmNode, b: PmNode): Hunk[] {
  const blocksA: PmNode[] = [];
  const blocksB: PmNode[] = [];
  a.content.forEach((child) => blocksA.push(child));
  b.content.forEach((child) => blocksB.push(child));
  const offA = childOffsets(a.content);
  const offB = childOffsets(b.content);

  let head = 0;
  while (
    head < blocksA.length &&
    head < blocksB.length &&
    blocksA[head]!.eq(blocksB[head]!)
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < blocksA.length - head &&
    tail < blocksB.length - head &&
    blocksA[blocksA.length - 1 - tail]!.eq(blocksB[blocksB.length - 1 - tail]!)
  ) {
    tail += 1;
  }
  const n = blocksA.length - head - tail;
  const m = blocksB.length - head - tail;
  if (n === 0 && m === 0) {
    return [];
  }

  // Runs of unmatched blocks as [startA, endA, startB, endB] block indexes.
  const runs: [number, number, number, number][] = [];
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) {
    runs.push([head, head + n, head, head + m]);
  } else {
    // lcs[i][j]: common blocks between A[head+i..] and B[head+j..].
    const lcs: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) {
      lcs.push(new Uint32Array(m + 1));
    }
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = blocksA[head + i]!.eq(blocksB[head + j]!)
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    let runA = 0;
    let runB = 0;
    const flush = () => {
      if (runA !== i || runB !== j) {
        runs.push([head + runA, head + i, head + runB, head + j]);
      }
    };
    while (i < n || j < m) {
      if (i < n && j < m && blocksA[head + i]!.eq(blocksB[head + j]!)) {
        flush();
        i += 1;
        j += 1;
        runA = i;
        runB = j;
      } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
        i += 1;
      } else {
        j += 1;
      }
    }
    flush();
  }

  const hunks: Hunk[] = [];
  const pushHunk = (sA: number, eA: number, sB: number, eB: number) => {
    const hunk = refineHunk(a, b, offA[sA]!, offA[eA]!, offB[sB]!, offB[eB]!);
    if (hunk) {
      hunks.push(hunk);
    }
  };
  for (const [startA, endA, startB, endB] of runs) {
    // A run with as many blocks on each side reads as blocks edited in
    // place, so each pair is its own hunk and a conflict in one block does
    // not hold back its neighbours.
    if (endA - startA === endB - startB) {
      for (let k = 0; k < endA - startA; k++) {
        pushHunk(startA + k, startA + k + 1, startB + k, startB + k + 1);
      }
    } else {
      pushHunk(startA, endA, startB, endB);
    }
  }
  return hunks;
}

function diffSize(hunks: Hunk[]): number {
  return hunks.reduce(
    (total, h) => total + (h.toA - h.fromA) + (h.toB - h.fromB),
    0,
  );
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/** A document paired with the Mapping from it to the editor's current doc. */
interface Anchor {
  doc: PmNode;
  mapping: Mapping;
}

export interface RemoteMergeResult {
  /** Dispatch this; it carries the tracker's next state in its metadata. */
  tr: Transaction;
  /** A hunk overlapped local edits and was skipped in favor of the user's text. */
  conflicted: boolean;
}

const remoteMergeKey = new PluginKey("remoteMerge");

/** Anchors the save path has written, newest last. */
const MAX_SENT_ANCHORS = 3;
/** Local snapshots awaiting a save, newest last. */
const MAX_PENDING_SNAPSHOTS = 50;

/** True when the local edits since the anchor leave `hunk`'s old range intact. */
function hunkIsUntouched(anchor: Anchor, current: PmNode, hunk: Hunk): boolean {
  if (hunk.fromA === hunk.toA) {
    return !anchor.mapping.mapResult(hunk.fromA, 1).deletedAcross;
  }
  const from = anchor.mapping.mapResult(hunk.fromA, 1);
  const to = anchor.mapping.mapResult(hunk.toA, -1);
  if (to.pos - from.pos !== hunk.toA - hunk.fromA) {
    return false;
  }
  return current
    .slice(from.pos, to.pos)
    .eq(anchor.doc.slice(hunk.fromA, hunk.toA));
}

export class RemoteMergeTracker {
  private remote: Anchor;
  private sent: Anchor[] = [];
  private pending: Anchor[] = [];

  constructor(doc: PmNode) {
    this.remote = { doc, mapping: new Mapping() };
  }

  /**
   * Advances the anchors past a transaction the editor applied. Call it for
   * every applied transaction, including those appended by plugins.
   */
  applyTransaction(tr: Transaction): void {
    const merged = tr.getMeta(remoteMergeKey) as Anchor | undefined;
    if (!tr.docChanged && !merged) {
      return;
    }
    for (const anchor of [...this.sent, ...this.pending]) {
      anchor.mapping.appendMapping(tr.mapping);
    }
    if (merged) {
      this.remote = merged;
    } else {
      this.remote.mapping.appendMapping(tr.mapping);
    }
    if (tr.docChanged) {
      this.pending.push({ doc: tr.doc, mapping: new Mapping() });
      if (this.pending.length > MAX_PENDING_SNAPSHOTS) {
        this.pending.shift();
      }
    }
  }

  /**
   * Records that the save path wrote `markdown`. The newest local snapshot
   * that serializes to it becomes a sent anchor.
   */
  markSent(markdown: string, serialize: (doc: PmNode) => string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const snapshot = this.pending[i]!;
      if (serialize(snapshot.doc) === markdown) {
        this.sent.push(snapshot);
        if (this.sent.length > MAX_SENT_ANCHORS) {
          this.sent.shift();
        }
        this.pending = this.pending.slice(i + 1);
        return;
      }
    }
  }

  /**
   * Builds the transaction that merges `incoming` into `state`, or returns
   * null when the incoming body adds nothing to what the editor holds.
   */
  merge(state: EditorState, incoming: PmNode): RemoteMergeResult | null {
    let anchor = this.remote;
    let hunks = diffDocs(anchor.doc, incoming);
    let size = diffSize(hunks);
    for (const candidate of this.sent) {
      const candidateHunks = diffDocs(candidate.doc, incoming);
      const candidateSize = diffSize(candidateHunks);
      if (
        candidateSize < size ||
        (candidateSize === size &&
          candidate.mapping.maps.length < anchor.mapping.maps.length)
      ) {
        anchor = candidate;
        hunks = candidateHunks;
        size = candidateSize;
      }
    }
    if (hunks.length === 0) {
      this.remote = { doc: incoming, mapping: anchor.mapping.slice() };
      return null;
    }

    const current = state.doc;
    const tr = state.tr;
    const remote = new Transform(anchor.doc);
    // tr step index -> remote step index, for steps that mirror each other.
    const mirrors = new Map<number, number>();
    let conflicted = false;

    // Descending, so each hunk's anchor positions are unaffected by the ones
    // already applied above it.
    for (const hunk of [...hunks].reverse()) {
      const slice = incoming.slice(hunk.fromB, hunk.toB);
      const remoteStep = replaceStep(remote.doc, hunk.fromA, hunk.toA, slice);
      if (!remoteStep || remote.maybeStep(remoteStep).failed) {
        throw new Error("Remote hunk does not apply to its own anchor");
      }
      if (!hunkIsUntouched(anchor, current, hunk)) {
        conflicted = true;
        continue;
      }
      const from = tr.mapping.map(anchor.mapping.map(hunk.fromA, 1), 1);
      const to =
        hunk.fromA === hunk.toA
          ? from
          : tr.mapping.map(anchor.mapping.map(hunk.toA, -1), -1);
      const localStep = replaceStep(tr.doc, from, Math.max(from, to), slice);
      if (!localStep || tr.maybeStep(localStep).failed) {
        conflicted = true;
        continue;
      }
      if (sameReplacement(remoteStep, localStep)) {
        mirrors.set(tr.steps.length - 1, remote.steps.length - 1);
      }
    }

    tr.setMeta(remoteMergeKey, {
      doc: incoming,
      mapping: rebasedMapping(remote.steps, anchor.mapping, tr, mirrors),
    } satisfies Anchor);
    tr.setMeta("addToHistory", false);
    tr.setMeta("preventUpdate", true);
    return { tr, conflicted };
  }
}

function sameReplacement(a: Step, b: Step): boolean {
  return (
    a instanceof ReplaceStep &&
    b instanceof ReplaceStep &&
    a.to - a.from === b.to - b.from &&
    a.slice.eq(b.slice)
  );
}

/**
 * The Mapping from the incoming doc to the merged one: back through the
 * remote steps, forward through the local edits since the anchor, then
 * through the merge transaction. Paired steps are mirrors, so positions
 * inside remotely inserted content survive the round trip.
 */
function rebasedMapping(
  remoteSteps: readonly Step[],
  local: Mapping,
  tr: Transaction,
  mirrors: Map<number, number>,
): Mapping {
  const mapping = new Mapping();
  for (let i = remoteSteps.length - 1; i >= 0; i--) {
    mapping.appendMap(remoteSteps[i]!.getMap().invert());
  }
  mapping.appendMapping(local);
  tr.steps.forEach((step, index) => {
    const remoteIndex = mirrors.get(index);
    mapping.appendMap(
      step.getMap(),
      remoteIndex === undefined
        ? undefined
        : remoteSteps.length - 1 - remoteIndex,
    );
  });
  return mapping;
}
