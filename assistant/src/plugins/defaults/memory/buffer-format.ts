// ---------------------------------------------------------------------------
// Memory buffer entry format: the single owner
// ---------------------------------------------------------------------------
//
// `memory/buffer.md` is the append-only staging log that `remember()` writes
// and consolidation drains. Its line format is written here and recognized
// here, by one matcher, so the writer and every reader agree by construction.
//
// This module deliberately sits at the plugin root (shared infra, not a tier)
// and imports nothing. `substrate/` is the bottom tier and may not import a
// tier, but plugin-root infra is fair game, so all readers can reach this one
// without inverting the layering.
//
// A second matcher for this format anywhere in the tree is a bug. Two copies
// disagree on the shapes nobody thinks to test (indentation, spacing after the
// bullet dash, spacing inside the date), and each disagreement splits or merges
// somebody's fact.

/**
 * A parsed buffer entry opening line.
 */
export interface BufferEntryStart {
  /**
   * The bracketed timestamp, verbatim. Returned unparsed so it can serve
   * directly as a consolidation cutoff: both sides of the agent's
   * "timestamp >= cutoff" comparison then share this exact shape.
   */
  timestamp: string;
  /** Everything after the timestamp bracket, trimmed. */
  text: string;
}

/**
 * Matches an entry opening line: `- [Mon D, h:mm AM/PM] fact`, the shape
 * {@link formatRememberEntry} writes.
 *
 * Anchored at column 0, requiring a space after the dash, and spelling the
 * timestamp with the single spaces {@link formatBufferTimestamp} emits.
 * Everything else in the file is a continuation line belonging to the entry
 * above it, which is how a multiline fact keeps its body: `remember()` writes
 * only the opening line at column 0 and nests the body beneath it. That rule
 * is what makes a bullet carrying other bracketed text (a `- [ ]` checklist
 * item, a `- [[wikilink]]` bullet) read as continuation rather than as a new
 * fact, and it is why a body line can never imitate an opening.
 *
 * Matching the writer's exact shape is the conservative choice in both
 * directions: a line the writer could not have produced stays body text, so an
 * odd hand-edit merges into the fact around it instead of splitting that fact
 * or supplying a malformed timestamp to a caller that treats one as a cutoff.
 *
 * Group 1 is the timestamp, group 2 the fact text.
 */
const BUFFER_ENTRY_REGEX =
  /^- \[([A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M)\]\s*(.*)$/;

/**
 * Parse `line` as an entry opening, or `null` if it is a continuation line.
 *
 * Pass the raw line. Callers must not trim it first: leading whitespace is
 * exactly what distinguishes an indented body line from a real entry, so a
 * trimmed line reads an indented body bullet as a fresh fact and splits one
 * entry into two.
 */
export function matchBufferEntryStart(line: string): BufferEntryStart | null {
  const match = BUFFER_ENTRY_REGEX.exec(line.trimEnd());
  if (match === null) {
    return null;
  }
  return { timestamp: match[1]!, text: match[2]!.trim() };
}

/** Whether `line` opens a buffer entry. See {@link matchBufferEntryStart}. */
export function isBufferEntryStart(line: string): boolean {
  return BUFFER_ENTRY_REGEX.test(line.trimEnd());
}

/**
 * Format `now` as a buffer-entry timestamp (`Mon D, h:mm AM/PM`). Exported so
 * the consolidation job can present its cutoff in the same shape the buffer
 * entries use, making the agent's "timestamp >= cutoff" comparison
 * unambiguous at minute precision.
 */
export function formatBufferTimestamp(now: Date): string {
  const month = now.toLocaleString("en-US", { month: "short" });
  const day = now.getDate();
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${month} ${day}, ${displayHour}:${minutes} ${ampm}`;
}

/**
 * Indent applied to a fact's continuation lines. Two spaces is the markdown
 * convention for content nested under a `- ` bullet, so an entry stays
 * readable as a list item.
 */
const CONTINUATION_INDENT = "  ";

/**
 * Build a timestamped bullet entry for `buffer.md` / `archive/<date>.md`.
 *
 * Format mirrors the long-standing v1 PKB layout so buffers stay
 * human-readable and downstream consumers (sweep, consolidation, the graph
 * view) can parse the same shape regardless of which path produced the entry.
 *
 * A fact's body is indented, which is what makes the format round-trip. The
 * buffer is line-delimited and the delimiter is "canonical entry shape at
 * column 0", so a body line carrying that exact shape would otherwise be
 * indistinguishable from the start of the next fact and split one entry into
 * two. Indenting moves every body line off column 0, so no fact content can
 * imitate a delimiter no matter what the user dictated. Blank lines stay
 * genuinely blank rather than becoming whitespace.
 *
 * Readers strip the indent: {@link matchBufferEntryStart} classifies on the
 * raw line while `parseBufferEntries` trims continuation lines, so the fact
 * text a caller gets back is unchanged by this.
 *
 * Exported so memory sweep / extractor jobs format their auto-remembered
 * entries identically to user-facing `remember()` calls.
 */
export function formatRememberEntry(content: string, now: Date): string {
  const [opening = "", ...body] = content.split("\n");
  const nested = body.map((line) =>
    line.trim().length === 0 ? "" : `${CONTINUATION_INDENT}${line}`,
  );
  return `- [${formatBufferTimestamp(now)}] ${[opening, ...nested].join("\n")}\n`;
}

/**
 * Split buffer content into entries, each keeping its lines verbatim.
 *
 * The unit callers almost always want. Counting or trimming a buffer by raw
 * lines conflates a five-line fact with five facts, and cuts a fact in half
 * wherever the count runs out.
 *
 * Leading lines that precede the first entry opening (a hand-written buffer,
 * or stray prose) are returned as a headless first group with
 * `start === null`, so callers can decide what to do with them rather than
 * silently dropping content.
 */
export function splitBufferEntries(
  lines: readonly string[],
): BufferEntryLines[] {
  const groups: BufferEntryLines[] = [];
  for (const [index, line] of lines.entries()) {
    const start = matchBufferEntryStart(line);
    if (start !== null || groups.length === 0) {
      groups.push({ start, firstLine: index, lines: [line] });
      continue;
    }
    groups[groups.length - 1]!.lines.push(line);
  }
  return groups;
}

/** One entry's verbatim lines, as returned by {@link splitBufferEntries}. */
export interface BufferEntryLines {
  /** `null` for the headless group before the first entry opening. */
  start: BufferEntryStart | null;
  /** Index of this group's first line in the input array. */
  firstLine: number;
  /** The group's lines, verbatim and in order. */
  lines: string[];
}
