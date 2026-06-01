/**
 * The shared `<memory>…</memory>` injection marker.
 *
 * Both the v2 graph-memory producers (`conversation-graph-memory.ts`) and the
 * v3 live renderer (`v3/render-injection.ts`) emit memory blocks with this
 * exact wrapper, and the strip/recognition machinery in
 * `conversation-graph-memory.ts` (`countMemoryPrefixBlocks`) matches the same
 * `"<memory>\n"` / `"\n</memory>"` delimiters. Keeping the producer wrapper in
 * one leaf module guarantees the byte-for-byte marker contract across v2 and
 * v3 — a change here updates every producer at once.
 *
 * This is a tiny dependency-free leaf so the pure v3 renderer can import it
 * without pulling in the heavyweight graph-memory module.
 */
export function wrapMemoryBlock(text: string): string {
  return `<memory>\n${text}\n</memory>`;
}
