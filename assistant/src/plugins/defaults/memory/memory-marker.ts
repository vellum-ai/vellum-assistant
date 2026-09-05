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

/**
 * Inverse of {@link wrapMemoryBlock}: recover the inner text from a wrapped
 * block. Only unwraps when the full `<memory>\n…\n</memory>` pair is present,
 * so payloads that merely start with the opening tag pass through unchanged —
 * the same defensive guard the metadata rehydration in
 * `daemon/conversation.ts` applies.
 */
export function unwrapMemoryBlock(block: string): string {
  return block.startsWith("<memory>\n") && block.endsWith("\n</memory>")
    ? block.slice("<memory>\n".length, -"\n</memory>".length)
    : block;
}

/**
 * The memory-v3 per-turn pointer wrapper: the `<memory_pointer>` block lists
 * the turn's re-selected sections that are already resident in history. It is
 * ephemeral by contract: never persisted, stripped from every user message at
 * the start of each turn (`stripPointerInjections`) and by compaction via
 * `RUNTIME_INJECTION_PREFIXES`, then re-spliced fresh onto the tail. The
 * producer wrapper lives here beside the `<memory>` marker it parallels.
 */
export const MEMORY_POINTER_PREFIX = "<memory_pointer>\n";
export const MEMORY_POINTER_SUFFIX = "\n</memory_pointer>";

export function wrapMemoryPointerBlock(text: string): string {
  return `${MEMORY_POINTER_PREFIX}${text}${MEMORY_POINTER_SUFFIX}`;
}
