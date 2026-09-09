/**
 * The grammar of persisted memory-injection blocks: the
 * `# memory/concepts/<slug>.md` header convention (builder, matcher, slug and
 * section-ref extraction), the non-section chunk headers, the body escaping
 * that keeps a section's own text from forging a boundary, and the chunk
 * parser every read side shares.
 *
 * The v2 injection renderer (`injection.ts`), the v3 selector card renderer
 * (`plugins/defaults/memory/v3/card.ts`), and the v3 section renderer
 * (`plugins/defaults/memory/v3/page-content.ts`) all open a concept page's
 * chunk with this header inside the block that is persisted on the user
 * message (`metadata.memoryInjectedBlock` / `metadata.memoryV3InjectedBlock`)
 * and re-attached at request build. A v3 heading section extends the header
 * with ` § <section key>` (see {@link injectedSectionHeader}); the lead keeps
 * the bare page header. Capability content (`# Skill: ` / `# CLI command: `)
 * and the skills catalog hint (`# Skills`) open their own non-section chunks.
 * The v3 prune valve's live strip, the `loadFromDb` rehydration filter, the
 * truncated-fork seed scan, and the retry anchor merge all read blocks
 * through {@link parseInjectedSections}, so the grammar has one writer-side
 * and one reader-side definition and the two cannot drift.
 *
 * The parser reads this escaped grammar only. A v3 block persisted without
 * the format stamp (`memoryV3InjectedBlockFormat`; `InjectedBlockFormat` in
 * `plugins/defaults/memory/v3/types.ts`) was rendered as compact cards by a
 * build before body escaping and is never handed to the parser: the legacy
 * card grammar below ({@link parseLegacyCards}, {@link filterLegacyCards})
 * reads it exactly as that build did, so a card pruned before the upgrade
 * is filtered out of it at rehydration and in the live strip.
 *
 * Skill and CLI-command chunks carry no recoverable slug, so the slug
 * extractor intentionally skips them.
 *
 * Kept a leaf (like `memory-marker.ts`; its one import is the host's JSON
 * helper) so the conversation-fork path can import it without pulling in
 * the heavyweight injection module.
 */

import { safeParseRecord } from "../../../../util/json.js";

/** Separator between a concept path and its section key in a v3 section
 *  header or pointer line. */
const INJECTED_SECTION_KEY_SEPARATOR = " § ";

/** Header line of the skills catalog hint chunk `renderInjectionBlockInner`
 *  places ahead of skill content. */
export const SKILLS_CATALOG_HINT_HEADER = "# Skills";

/** Header prefixes of the two capability render forms. Capability chunks open
 *  with these instead of a concept header, so the parser treats a line
 *  starting with either as its own non-section chunk boundary. */
export const SKILL_HEADER_PREFIX = "# Skill: ";
export const CLI_COMMAND_HEADER_PREFIX = "# CLI command: ";

/** The workspace-relative path of a concept page, as the injected headers and
 *  the `file_read` affordance spell it. */
function injectedConceptPath(slug: string): string {
  return `memory/concepts/${slug}.md`;
}

/** Render the concept-page path header that opens a page's chunk inside an
 *  injected memory block. The read-side inverse is
 *  {@link INJECTED_CONCEPT_HEADER_REGEX}. */
export function injectedConceptHeader(slug: string): string {
  return `# ${injectedConceptPath(slug)}`;
}

/** A section's path line: the concept path, extended with ` § <key>` for a
 *  heading section. The lead (key `""`) is the bare path. The read-side
 *  inverse is {@link parseInjectedSectionPath}. */
export function injectedSectionPath(slug: string, key: string): string {
  return key.length === 0
    ? injectedConceptPath(slug)
    : `${injectedConceptPath(slug)}${INJECTED_SECTION_KEY_SEPARATOR}${key}`;
}

/** Render the header line that opens an injected v3 section: the section's
 *  path line under `# `. The read-side inverse is
 *  {@link INJECTED_CONCEPT_HEADER_REGEX}. */
export function injectedSectionHeader(slug: string, key: string): string {
  return `# ${injectedSectionPath(slug, key)}`;
}

/**
 * Pattern of a section path line (`memory/concepts/<slug>.md[ § <key>]`):
 * capture group 1 is the page slug and group 2 the section key (absent for a
 * lead). The slug capture is lazy so a key containing `.md` never bleeds into
 * the slug. The shared source of the header matcher and the pointer-line
 * matcher.
 */
const SECTION_PATH_SOURCE = `memory\\/concepts\\/(.+?)\\.md(?:${RegExp.escape(INJECTED_SECTION_KEY_SEPARATOR)}(.+))?`;

/**
 * Matches an {@link injectedConceptHeader} or {@link injectedSectionHeader}
 * line inside an injected block; capture group 1 is the page slug and group 2
 * the section key (absent for a page header or a lead section).
 *
 * Flagged `gm` for `String.prototype.matchAll`, which clones the regex per
 * spec and so never mutates this shared instance's `lastIndex`. Do NOT call
 * `exec`/`test` on it directly, a `g`-flagged regex is stateful under those.
 */
const INJECTED_CONCEPT_HEADER_REGEX = new RegExp(
  `^# ${SECTION_PATH_SOURCE}$`,
  "gm",
);

/** Whole-line matcher of a pointer entry ({@link injectedSectionPath}). */
const INJECTED_SECTION_PATH_LINE_REGEX = new RegExp(`^${SECTION_PATH_SOURCE}$`);

/** Header-line pattern of a NON-section chunk (the skills hint, a skill or
 *  CLI-command render): the source shared by the parser and the escaper. */
const NON_SECTION_CHUNK_HEADER_SOURCE = `(?:${RegExp.escape(SKILLS_CATALOG_HINT_HEADER)}$|${RegExp.escape(SKILL_HEADER_PREFIX)}|${RegExp.escape(CLI_COMMAND_HEADER_PREFIX)})`;

const NON_SECTION_CHUNK_HEADER_REGEX = new RegExp(
  `^${NON_SECTION_CHUNK_HEADER_SOURCE}`,
  "gm",
);

/** Whole-line test: is this line in the escape class (a section header or a
 *  non-section chunk header, the lines the parser cuts chunks at)? */
const GRAMMAR_LINE_REGEX = new RegExp(
  `^(?:# ${SECTION_PATH_SOURCE}$|${NON_SECTION_CHUNK_HEADER_SOURCE})`,
);

/** UTF-8 byte length of rendered injection text, card or section: the
 *  measure the injectors record per entry and the prune valve budgets in. */
export function renderedBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Recover the (deduplicated, in-order) concept slugs a persisted injection
 *  block contains. */
export function extractInjectedConceptSlugs(block: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const match of block.matchAll(INJECTED_CONCEPT_HEADER_REGEX)) {
    const slug = match[1]!;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/** One `(slug, section key)` pair recovered from an injected block's headers
 *  or a pointer block's lines. */
interface InjectedSectionRef {
  slug: string;
  key: string;
}

/** Parse one pointer-block line back into its `(slug, key)` ref, or `null`
 *  for any other line (the pointer's lead line, free text). The exact inverse
 *  of {@link injectedSectionPath}. */
export function parseInjectedSectionPath(
  line: string,
): InjectedSectionRef | null {
  const match = INJECTED_SECTION_PATH_LINE_REGEX.exec(line);
  return match ? { slug: match[1]!, key: match[2] ?? "" } : null;
}

// ─── body escaping ───────────────────────────────────────────────────────────

/** Prefix that marks a body line as literal text rather than a grammar line.
 *  Markdown reads `\#` and `\[` as the literal characters, so the model sees
 *  the line as the text it is. */
const BODY_ESCAPE = "\\";

/** Whether the line, with its leading backslashes removed, is a grammar
 *  line: the class the escaper prefixes. Including already-backslashed
 *  variants keeps the escaper injective, so a body line that already
 *  carries the escape can never render like an escaped grammar line. */
function isEscapableLine(line: string): boolean {
  return GRAMMAR_LINE_REGEX.test(line.replace(/^\\+/, ""));
}

/**
 * Escape a rendered body so none of its lines can be read as grammar by
 * {@link parseInjectedSections}: a line that is a section header or a
 * non-section chunk header, or such a line behind a run of backslashes,
 * gets one leading backslash. Every other line is untouched.
 */
export function escapeInjectedBody(body: string): string {
  return body
    .split("\n")
    .map((line) => (isEscapableLine(line) ? `${BODY_ESCAPE}${line}` : line))
    .join("\n");
}

// ─── block parsing ───────────────────────────────────────────────────────────

/** One parsed injected section: the header line plus everything up to the
 *  next chunk boundary (or end of block), trailing whitespace removed. */
interface ParsedInjectedSection extends InjectedSectionRef {
  /** The section text INCLUDING its header line, `trimEnd()`ed so re-joining
   *  with `\n\n` reproduces the renderer's exact bytes. */
  text: string;
}

/**
 * One ordered chunk of a parsed injection block, each `\n\n`-joined by the
 * renderer: an injected section (prunable, owned by `(slug, key)`), a
 * capability render (a skill or CLI command under its own header, naming the
 * id that header carries; never prunable), or any other chunk (the skills
 * hint; never prunable).
 */
export type InjectionBlockPiece =
  | { kind: "section"; slug: string; key: string; text: string }
  | {
      kind: "capability";
      capability: "skill" | "cli-command";
      id: string;
      text: string;
    }
  | { kind: "other"; text: string };

type BoundaryRef =
  | { kind: "section"; slug: string; key: string }
  | { kind: "capability"; capability: "skill" | "cli-command"; id: string }
  | { kind: "other" };

/** A chunk boundary: the offset of the header line that opens a piece, with
 *  the piece's classification. */
interface Boundary<Ref> {
  index: number;
  ref: Ref;
}

/**
 * Cut `inner` at `boundaries` (sorted in place) into the preamble before the
 * first one and one piece per boundary: its `ref` plus the text from its
 * header up to the next boundary, `trimEnd()`ed so re-joining pieces with
 * `\n\n` reproduces the renderer's exact bytes. With no boundary the whole
 * text is the preamble.
 */
function cutAtBoundaries<Ref extends object>(
  inner: string,
  boundaries: Array<Boundary<Ref>>,
): { preamble: string; pieces: Array<Ref & { text: string }> } {
  if (boundaries.length === 0) {
    return { preamble: inner, pieces: [] };
  }
  boundaries.sort((a, b) => a.index - b.index);
  const preamble = inner.slice(0, boundaries[0]!.index).trimEnd();
  const pieces = boundaries.map((boundary, i) => {
    const end =
      i + 1 < boundaries.length ? boundaries[i + 1]!.index : undefined;
    return {
      ...boundary.ref,
      text: inner.slice(boundary.index, end).trimEnd(),
    };
  });
  return { preamble, pieces };
}

/**
 * Re-join the pieces kept from a parsed block behind its preamble on the
 * renderer's `\n\n` seams, byte-identical to a fresh render of those chunks.
 * Returns `inner` UNCHANGED (same reference) when every piece is kept, so a
 * caller detects a no-op by identity, and `""` when none is (a bare preamble
 * carries no content; the caller drops the block).
 */
export function rejoinKeptPieces(
  inner: string,
  parsed: { preamble: string; pieces: ReadonlyArray<{ text: string }> },
  kept: ReadonlyArray<{ text: string }>,
): string {
  if (kept.length === parsed.pieces.length) {
    return inner;
  }
  if (kept.length === 0) {
    return "";
  }
  const texts = kept.map((piece) => piece.text);
  if (parsed.preamble.length > 0) {
    texts.unshift(parsed.preamble);
  }
  return texts.join("\n\n");
}

/** Whether a header match at `index` opens its own `\n\n`-joined chunk: it
 *  starts the text or follows a blank line. */
function onChunkSeam(inner: string, index: number): boolean {
  return (
    index === 0 ||
    (index >= 2 && inner[index - 1] === "\n" && inner[index - 2] === "\n")
  );
}

function lineEndAt(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline;
}

function classifyNonSectionHeader(line: string): BoundaryRef {
  if (line.startsWith(SKILL_HEADER_PREFIX)) {
    return {
      kind: "capability",
      capability: "skill",
      id: line.slice(SKILL_HEADER_PREFIX.length),
    };
  }
  if (line.startsWith(CLI_COMMAND_HEADER_PREFIX)) {
    return {
      kind: "capability",
      capability: "cli-command",
      id: line.slice(CLI_COMMAND_HEADER_PREFIX.length),
    };
  }
  return { kind: "other" };
}

/**
 * Split an UNWRAPPED injection-block body into its preamble (the instruction
 * header: everything before the first boundary), the ordered chunk pieces,
 * and the injected sections (the `kind: "section"` pieces, kept as a
 * convenience view). Returns zero sections/pieces when the text carries no
 * chunk headers.
 *
 * A chunk boundary is a section header or a non-section chunk header (the
 * skills hint, `# Skill:`, `# CLI command:`) that opens the text or follows
 * a blank line, the seams `renderInjectionBlockInner` joins entries on. A
 * section therefore ends at the next section header or at a trailing
 * capability chunk, which is parsed as a separate piece instead of being
 * absorbed, so pruning the section never deletes it. Any other `# ` line,
 * including a lead's own `# Title` line and any heading a section body
 * carries, stays inside its section; a body line that would itself read as
 * grammar arrives backslash-escaped from {@link escapeInjectedBody}, so only
 * producer-written headers can split. Splitting only on seams keeps re-joins
 * byte-identical.
 *
 * Only a block rendered under this grammar is handed to the parser (a
 * persisted block carrying the format stamp, or one rendered in-process); a
 * pre-stamp block is read by {@link parseLegacyCards}.
 */
export function parseInjectedSections(inner: string): {
  preamble: string;
  sections: ParsedInjectedSection[];
  pieces: InjectionBlockPiece[];
} {
  const boundaries: Array<Boundary<BoundaryRef>> = [];
  for (const match of inner.matchAll(INJECTED_CONCEPT_HEADER_REGEX)) {
    if (onChunkSeam(inner, match.index!)) {
      boundaries.push({
        index: match.index!,
        ref: { kind: "section", slug: match[1]!, key: match[2] ?? "" },
      });
    }
  }
  for (const match of inner.matchAll(NON_SECTION_CHUNK_HEADER_REGEX)) {
    if (onChunkSeam(inner, match.index!)) {
      boundaries.push({
        index: match.index!,
        ref: classifyNonSectionHeader(
          inner.slice(match.index!, lineEndAt(inner, match.index!)),
        ),
      });
    }
  }
  const { preamble, pieces } = cutAtBoundaries(inner, boundaries);
  const sections = pieces.filter(
    (piece): piece is Extract<InjectionBlockPiece, { kind: "section" }> =>
      piece.kind === "section",
  );
  return { preamble, sections, pieces };
}

// ─── legacy card grammar ─────────────────────────────────────────────────────

/**
 * Header line of a legacy card: the bare page header, one compact card per
 * page, the grammar the builds before the format stamp rendered a block
 * with. The one sanctioned second header matcher beside
 * {@link INJECTED_CONCEPT_HEADER_REGEX}: {@link parseLegacyCards} alone
 * reads it, it is never applied to a current-format block, and it stays
 * byte-identical to the pre-stamp build's regex rather than being derived
 * from the section-path source. Greedy in the slug (no section key existed
 * to bleed into it). Flagged `gm` for `matchAll`: never `exec`/`test` it.
 */
const LEGACY_CARD_HEADER_REGEX = /^# memory\/concepts\/(.+)\.md$/gm;

/** Any top-level `# ` line: a card header or a foreign one (a capability
 *  chunk's `# Skill:` / `# CLI command:` line, the `# Skills` hint). */
const TOP_LEVEL_HEADER_REGEX = /^# /gm;

type LegacyCardRef = { kind: "card"; slug: string } | { kind: "other" };

/** One ordered chunk of a parsed legacy card block: a page's card (owned by
 *  `slug`) or any other `\n\n`-joined chunk (capability content under its
 *  own header, the skills hint; never dropped). */
type LegacyCardPiece = LegacyCardRef & { text: string };

/**
 * Split an UNWRAPPED legacy card block (a `memoryV3InjectedBlock` persisted
 * without the format stamp) into its preamble and ordered chunk pieces,
 * under the grammar the build that rendered it read: a card opens at every
 * page header wherever it sits (bodies were not escaped, so a page line
 * shaped like one splits here exactly as it did for that build's valve) and
 * ends at the next page header or at any other top-level `# ` line on a
 * `\n\n` seam, so a capability chunk trailing a card is its own piece and
 * dropping the card never deletes it. The seam requirement keeps a card
 * head's own `# Title` line, which follows the path header with a single
 * `\n`, inside the card. With no page header the whole text is the
 * preamble.
 */
export function parseLegacyCards(inner: string): {
  preamble: string;
  pieces: LegacyCardPiece[];
} {
  const boundaries: Array<Boundary<LegacyCardRef>> = [];
  const cardStarts = new Set<number>();
  for (const match of inner.matchAll(LEGACY_CARD_HEADER_REGEX)) {
    cardStarts.add(match.index!);
    boundaries.push({
      index: match.index!,
      ref: { kind: "card", slug: match[1]! },
    });
  }
  if (boundaries.length === 0) {
    return { preamble: inner, pieces: [] };
  }
  for (const match of inner.matchAll(TOP_LEVEL_HEADER_REGEX)) {
    if (!cardStarts.has(match.index!) && onChunkSeam(inner, match.index!)) {
      boundaries.push({ index: match.index!, ref: { kind: "other" } });
    }
  }
  return cutAtBoundaries(inner, boundaries);
}

/**
 * Remove from an unwrapped legacy card block every card whose page slug
 * `drop` names; non-card chunks are always kept. Same contract as
 * {@link rejoinKeptPieces}: the input UNCHANGED (same reference) when
 * nothing is removed, `""` when every chunk is, and a remainder
 * byte-identical to a fresh render of the kept chunks.
 */
export function filterLegacyCards(
  inner: string,
  drop: (slug: string) => boolean,
): string {
  const parsed = parseLegacyCards(inner);
  const kept = parsed.pieces.filter(
    (piece) => piece.kind !== "card" || !drop(piece.slug),
  );
  return rejoinKeptPieces(inner, parsed, kept);
}

/**
 * Read a persisted memory-injection block off a message's metadata JSON, or
 * `null` when absent/malformed. `key` selects the injection layer: v2's
 * `memoryInjectedBlock` or memory-v3's section block
 * (`MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`).
 */
export function readInjectedBlock(
  metadata: string | null | undefined,
  key: string,
): string | null {
  const block = readInjectedMetadata(metadata)[key];
  return typeof block === "string" ? block : null;
}

/** A message's metadata JSON as a record; empty when absent or malformed
 *  (anything but a JSON object). */
export function readInjectedMetadata(
  metadata: string | null | undefined,
): Record<string, unknown> {
  return metadata ? safeParseRecord(metadata) : {};
}
