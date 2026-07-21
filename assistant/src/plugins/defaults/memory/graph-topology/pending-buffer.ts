/**
 * Pending memories — `memory/buffer.md` entries rendered into the memory
 * graph.
 *
 * Buffer entries are facts captured by `remember` / create-memory that the
 * consolidation pass has not yet filed into concept pages. Surfacing them as
 * `pending` nodes closes the feedback gap between "saved" and "filed": a
 * just-created memory appears on the map immediately instead of after the
 * next consolidation run. Entries carrying `[[slug]]` page hints get a
 * `pending` edge to each hinted concept page that exists, so the fact hangs
 * off the region of the map it will be filed into.
 *
 * Read-only: the graph endpoint is a GET, so this module never enqueues
 * consolidation or mutates the buffer — the create route owns the
 * consolidation nudge.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { MemoryGraphEdge, MemoryGraphNode } from "./types.js";

/** Node id prefix marking a pending buffer entry (id = prefix + text hash). */
export const PENDING_NODE_ID_PREFIX = "buffer:";

/** Node/edge taxonomy tag for pending buffer entries. */
export const PENDING_KIND = "pending";

/**
 * Upper bound on pending nodes appended to the graph. A buffer this deep is a
 * consolidation backlog, not fresh feedback — the newest entries win because
 * the buffer is append-only, so the tail is the most recent.
 */
const MAX_PENDING_NODES = 200;

const PENDING_LABEL_MAX_CHARS = 60;

/** Matches a buffer bullet: `- [Mon D, h:mm AM/PM] fact`, timestamp optional. */
const BUFFER_ENTRY_REGEX = /^-\s+(?:\[[^\]]*\]\s*)?(.+)$/;

/** Matches `[[slug]]` / `[[slug|label]]` wikilinks inside an entry. */
const WIKILINK_REGEX = /\[\[([^[\]|]+)(?:\|[^\]]*)?\]\]/g;

export interface PendingBufferEntry {
  /** Stable node id (`buffer:` + content hash, deduped within one parse). */
  id: string;
  /** The entry's fact text, timestamp stripped, wikilink markup intact. */
  text: string;
  /** Slugs referenced via `[[slug]]` hints, normalized and deduped. */
  slugs: string[];
}

/** Small stable content hash (djb2, base36) so pending node ids survive
 * unrelated buffer appends — index-based ids would shift on every write. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Parse buffer markdown into pending entries. Non-bullet lines (headers,
 * blanks) are skipped. Duplicate fact texts get a `-2`, `-3`, … id suffix so
 * node ids stay unique within one graph payload.
 */
export function parseBufferEntries(content: string): PendingBufferEntry[] {
  const seen = new Map<string, number>();
  const entries: PendingBufferEntry[] = [];
  for (const line of content.split("\n")) {
    const match = BUFFER_ENTRY_REGEX.exec(line.trim());
    if (!match) {
      continue;
    }
    const text = match[1]!.trim();
    if (!text) {
      continue;
    }

    const slugs: string[] = [];
    for (const link of text.matchAll(WIKILINK_REGEX)) {
      const slug = link[1]!.trim();
      if (slug && !slugs.includes(slug)) {
        slugs.push(slug);
      }
    }

    const hash = hashText(text);
    const count = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, count);
    const id =
      count === 1
        ? `${PENDING_NODE_ID_PREFIX}${hash}`
        : `${PENDING_NODE_ID_PREFIX}${hash}-${count}`;

    entries.push({ id, text, slugs });
  }
  return entries;
}

/** Display label: wikilink markup collapsed to its last path segment, then
 * truncated. `Prefers [[tools/vs-code]]` → `Prefers vs-code`. */
function pendingLabel(text: string): string {
  const plain = text
    .replace(WIKILINK_REGEX, (_match, slug: string) => {
      return slug.trim().split("/").pop() ?? slug;
    })
    .trim();
  if (plain.length <= PENDING_LABEL_MAX_CHARS) {
    return plain;
  }
  return `${plain.slice(0, PENDING_LABEL_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Map pending entries to graph nodes + edges. Only hints naming a slug in
 * `knownSlugs` produce an edge — a hint to a page consolidation has yet to
 * create would dangle. Caps at {@link MAX_PENDING_NODES}, keeping the newest
 * (tail) entries.
 */
export function buildPendingGraph(
  entries: readonly PendingBufferEntry[],
  knownSlugs: ReadonlySet<string>,
): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const capped = entries.slice(-MAX_PENDING_NODES);
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  for (const entry of capped) {
    const linked = entry.slugs.filter((slug) => knownSlugs.has(slug));
    nodes.push({
      id: entry.id,
      label: pendingLabel(entry.text),
      summary: entry.text,
      kind: PENDING_KIND,
      weight: linked.length,
    });
    for (const slug of linked) {
      edges.push({
        source: entry.id,
        target: slug,
        kind: PENDING_KIND,
        directed: true,
      });
    }
  }
  return { nodes, edges };
}

/**
 * Read + parse `memory/buffer.md`. A missing or unreadable buffer yields no
 * pending entries — the graph renders without them rather than erroring.
 */
export async function readPendingBufferEntries(
  workspaceDir: string,
): Promise<PendingBufferEntry[]> {
  const content = await readFile(
    join(workspaceDir, "memory", "buffer.md"),
    "utf-8",
  ).catch(() => "");
  return parseBufferEntries(content);
}
