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
 * truncated-fork seed scan, and the inspector's reconstruction all read
 * blocks through {@link parseInjectedSections}, so the grammar has one
 * writer-side and one reader-side definition and the two cannot drift.
 *
 * Blocks frozen by builds before body escaping (compact cards: concept
 * header, the page head, a blank line, then a `[sections: …]` or
 * `[linked: …]` TOC line) carry no escaping, so the parser recognises that
 * card shape and, given the byte lengths the conversation recorded for its
 * frozen cards, never splits such a card at a header-shaped line inside its
 * lead; see {@link parseInjectedSections}. Current blocks escape TOC-shaped
 * lines as well, so the card rule can never fire on them.
 *
 * Skill and CLI-command chunks carry no recoverable slug, so the slug
 * extractor intentionally skips them.
 *
 * Kept as a leaf (like `memory-marker.ts`, importing only the capability
 * slug leaf) so the conversation-fork path can import it without pulling in
 * the heavyweight injection module.
 */

import { capabilitySlugOf } from "./capability-slugs.js";

/** Separator between a concept path and its section key in a v3 section
 *  header or pointer line. */
export const INJECTED_SECTION_KEY_SEPARATOR = " § ";

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
export function injectedConceptPath(slug: string): string {
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
export const INJECTED_CONCEPT_HEADER_REGEX = new RegExp(
  `^# ${SECTION_PATH_SOURCE}$`,
  "gm",
);

/** Whole-line matcher of a concept header. */
const CONCEPT_HEADER_LINE_REGEX = new RegExp(`^# ${SECTION_PATH_SOURCE}$`);

/** Whole-line matcher of a pointer entry ({@link injectedSectionPath}). */
const INJECTED_SECTION_PATH_LINE_REGEX = new RegExp(`^${SECTION_PATH_SOURCE}$`);

/** Header-line pattern of a NON-section chunk (the skills hint, a skill or
 *  CLI-command render): the source shared by the parser and the escaper. */
const NON_SECTION_CHUNK_HEADER_SOURCE = `(?:${RegExp.escape(SKILLS_CATALOG_HINT_HEADER)}$|${RegExp.escape(SKILL_HEADER_PREFIX)}|${RegExp.escape(CLI_COMMAND_HEADER_PREFIX)})`;

const NON_SECTION_CHUNK_HEADER_REGEX = new RegExp(
  `^${NON_SECTION_CHUNK_HEADER_SOURCE}`,
  "gm",
);

/**
 * The closing TOC line of a compact card as builds before body escaping
 * froze it (`[sections: §A · §B]` or `[linked: …]`), preceded in the card by
 * a blank line. Frozen to that output on purpose: it is a read-side
 * compatibility pattern for persisted blocks, not the selector card
 * renderer's format.
 */
const LEGACY_CARD_TOC_LINE_SOURCE = String.raw`\[(?:sections|linked): .*\]`;
const LEGACY_CARD_TOC_LINE_REGEX = new RegExp(
  `^${LEGACY_CARD_TOC_LINE_SOURCE}$`,
);

/** Whole-line test: would this line carry grammar meaning if it sat on a
 *  chunk seam (a section header, a non-section chunk header, or a legacy
 *  card TOC line)? */
const GRAMMAR_LINE_REGEX = new RegExp(
  `^(?:# ${SECTION_PATH_SOURCE}$|${NON_SECTION_CHUNK_HEADER_SOURCE}|${LEGACY_CARD_TOC_LINE_SOURCE}$)`,
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
export interface InjectedSectionRef {
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
 *  line: the class the escaper prefixes and the unescaper strips one
 *  backslash from. Including already-backslashed variants keeps the pair an
 *  exact bijection. */
function isEscapableLine(line: string): boolean {
  return GRAMMAR_LINE_REGEX.test(line.replace(/^\\+/, ""));
}

/**
 * Escape a rendered body so none of its lines can be read as grammar by
 * {@link parseInjectedSections}: a line that is a section header, a
 * non-section chunk header, or a legacy card TOC line, or such a line behind
 * a run of backslashes, gets one leading backslash. Every other line is
 * untouched. {@link unescapeInjectedBody} is the exact inverse.
 */
export function escapeInjectedBody(body: string): string {
  return body
    .split("\n")
    .map((line) => (isEscapableLine(line) ? `${BODY_ESCAPE}${line}` : line))
    .join("\n");
}

/** The exact inverse of {@link escapeInjectedBody}: strips the one backslash
 *  the escaper added to each grammar-shaped line. */
export function unescapeInjectedBody(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.startsWith(BODY_ESCAPE) && isEscapableLine(line)
        ? line.slice(BODY_ESCAPE.length)
        : line,
    )
    .join("\n");
}

// ─── block parsing ───────────────────────────────────────────────────────────

/** One parsed injected section: the header line plus everything up to the
 *  next chunk boundary (or end of block), trailing whitespace removed. */
export interface ParsedInjectedSection extends InjectedSectionRef {
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

interface Boundary {
  index: number;
  ref: BoundaryRef;
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

/** The line after the one starting at `index`, or `null` at the end. */
function lineAfter(text: string, index: number): string | null {
  const end = lineEndAt(text, index);
  return end === text.length
    ? null
    : text.slice(end + 1, lineEndAt(text, end + 1));
}

/** The nearest non-blank line before the line starting at `index`, or
 *  `null` when none precedes it. */
function nonBlankLineBefore(text: string, index: number): string | null {
  let end = index - 1;
  while (end >= 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(start, end);
    if (line.trim().length > 0) {
      return line;
    }
    end = start - 1;
  }
  return null;
}

/** Whether `text[from, to)` contains a legacy card TOC line on a seam (a
 *  blank line before it). */
function hasLegacyTocLine(text: string, from: number, to: number): boolean {
  let previousBlank = false;
  for (const line of text.slice(from, to).split("\n")) {
    if (previousBlank && LEGACY_CARD_TOC_LINE_REGEX.test(line)) {
      return true;
    }
    previousBlank = line.trim().length === 0;
  }
  return false;
}

/** Whether a header line's following line is what opens a legacy card's
 *  body: the page's own `# Title` line or a `[current: …]` annotation. */
function opensLegacyCard(line: string | null): boolean {
  return (
    line !== null &&
    (line.startsWith("[current: ") ||
      (line.startsWith("# ") && !CONCEPT_HEADER_LINE_REGEX.test(line)))
  );
}

/** Whether the card shape reads the header at `index` as opening a chunk on
 *  its own: it opens a card, or the card before it just closed (the previous
 *  content line is a TOC line). */
function shapeOpensChunk(inner: string, index: number): boolean {
  return (
    opensLegacyCard(lineAfter(inner, index)) ||
    LEGACY_CARD_TOC_LINE_REGEX.test(nonBlankLineBefore(inner, index) ?? "")
  );
}

/** The store's evidence that a candidate the card shape reads as card text
 *  is a real boundary after all: a concept header whose span is its slug's
 *  recorded frozen length, or a capability header naming a recorded
 *  capability slug. The skills hint was never recorded, so it never is. */
function recordedInStore(
  inner: string,
  candidates: Boundary[],
  i: number,
  cardBytes: ReadonlyMap<string, number> | undefined,
): boolean {
  const ref = candidates[i]!.ref;
  if (ref.kind === "section") {
    return (
      recordedSpanEnd(inner, candidates, i, cardBytes?.get(ref.slug) ?? 0) !==
      undefined
    );
  }
  if (ref.kind === "capability") {
    return cardBytes?.has(capabilitySlugOf(ref)) ?? false;
  }
  return false;
}

/** The end (a later candidate's index, or the block's end) at which the span
 *  from candidate `i`'s header, block joiner excluded, is exactly `recorded`
 *  bytes long: the frozen card's own extent, so the header is a real card
 *  boundary and the card runs to that end. `undefined` when no end matches;
 *  zero (unrecorded) never matches. */
function recordedSpanEnd(
  inner: string,
  candidates: Boundary[],
  i: number,
  recorded: number,
): number | undefined {
  if (recorded <= 0) {
    return undefined;
  }
  const start = candidates[i]!.index;
  const ends = [
    ...candidates.slice(i + 1).map((candidate) => candidate.index),
    inner.length,
  ];
  return ends.find(
    (end) => renderedBytes(inner.slice(start, end).trimEnd()) === recorded,
  );
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
 * How an injection block was rendered, which decides the grammar the parser
 * applies. `"current"`: rendered by a build with section headers and body
 * escaping, so only producer headers on seams are boundaries. `"legacy"`: a
 * compact-card block frozen by a build before either existed, read by the
 * card shape and the conversation's recorded frozen card lengths. Provenance
 * is explicit, never inferred from a block's content: the build that
 * persists a current block stamps `memoryV3InjectedBlockFormat` beside it in
 * the message metadata (`MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY` in
 * `v3/ever-injected-store.ts`), a persisted block without the stamp is
 * legacy, and a block memory-v3 places in live history carries its format in
 * the identity registry (`markV3LiveBlock` in `v3/types.ts`).
 */
export type InjectedBlockFormat = "legacy" | "current";

/** An injection block's unwrapped body with its rendering format: what every
 *  consumer hands the parser. */
export interface InjectedBlock {
  inner: string;
  format: InjectedBlockFormat;
}

export interface ParseInjectedSectionsOptions {
  /** The block's rendering format ({@link InjectedBlockFormat}). Under
   *  `"current"` only producer headers on seams split the block; the legacy
   *  card shape and `knownCardBytes` are not consulted. */
  format: InjectedBlockFormat;
  /** Recorded byte length of each frozen lead entry for the conversation,
   *  resident or pruned, keyed by slug (`getKnownCardBytes`); capability
   *  entries (`skills/<id>`, `cli-commands/<name>`) are recorded at zero. For
   *  a card frozen before body escaping the length is the exact UTF-8 length
   *  that build's injector measured for the whole card, which the section store's schema ensure carries over from
   *  `memory_v3_ever_injected`. Consulted under `format: "legacy"` only. Inside such a
   *  card, a concept header on a seam that the card shape reads as text is
   *  a boundary after all when the span from it to a later candidate header
   *  (block joiner excluded) has exactly its slug's recorded bytes, and a
   *  `# Skill: ` / `# CLI command: ` line the shape reads as text is a chunk
   *  boundary after all when the capability slug it names is a recorded key
   *  (membership, their bytes being zero). An unrecorded or zero page entry
   *  leaves the shape's verdict, never a bare slug-membership one. Omitted
   *  (no conversation at hand): the card shape alone decides. */
  knownCardBytes?: ReadonlyMap<string, number>;
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
 * grammar arrives backslash-escaped from {@link escapeInjectedBody}, so in a
 * block rendered by this build only producer-written headers can split.
 * Splitting only on seams keeps re-joins byte-identical.
 *
 * Blocks frozen by builds before body escaping (`options.format:
 * "legacy"`, the provenance the persisting build stamps beside each block,
 * see {@link InjectedBlockFormat}) hold compact cards (concept header, the
 * page head, a blank line, a `[sections: …]` / `[linked: …]` TOC line) whose
 * leads may contain a header-shaped line. Inside such a card, a bare concept
 * header (a lead's; heading-section headers never occur in those blocks) or
 * a non-section chunk header on a seam is read as card text when the card
 * shape says it does not open a card: its next line is neither the page's
 * `# Title` nor a `[current: …]` annotation, the previous content line is
 * not a TOC line (the preceding card is still open), and a TOC line follows
 * before the next header the shape reads as opening a chunk on its own (the
 * open card has yet to close).
 * That verdict is overturned only by the store's evidence in
 * `options.knownCardBytes`: a concept header whose span to some later
 * candidate matches its slug's recorded frozen length byte for byte, or a
 * capability header naming a recorded capability slug (the hint's `# Skills`
 * was never recorded, so inside a card it is always text). When the OPEN
 * card's own slug has a recorded length, that length governs directly: the
 * card's extent is its header through that many bytes, every candidate
 * starting inside it is card text, and the first candidate at the extent is
 * the next boundary, so a sectionless card (which has no TOC line for the
 * shape to close on) still holds its lead together; the shape rule is the
 * fallback for an open card with no recorded length, and a capability chunk
 * (recorded at zero) has no derivable extent and keeps it. Under
 * `options.format: "current"` none of this applies: such a block escapes
 * every grammar-shaped line and is split at producer headers alone, whatever
 * the conversation's frozen lengths say.
 */
export function parseInjectedSections(
  inner: string,
  options: ParseInjectedSectionsOptions,
): {
  preamble: string;
  sections: ParsedInjectedSection[];
  pieces: InjectionBlockPiece[];
} {
  const candidates: Boundary[] = [];
  for (const match of inner.matchAll(INJECTED_CONCEPT_HEADER_REGEX)) {
    if (onChunkSeam(inner, match.index!)) {
      candidates.push({
        index: match.index!,
        ref: { kind: "section", slug: match[1]!, key: match[2] ?? "" },
      });
    }
  }
  for (const match of inner.matchAll(NON_SECTION_CHUNK_HEADER_REGEX)) {
    if (onChunkSeam(inner, match.index!)) {
      candidates.push({
        index: match.index!,
        ref: classifyNonSectionHeader(
          inner.slice(match.index!, lineEndAt(inner, match.index!)),
        ),
      });
    }
  }
  candidates.sort((a, b) => a.index - b.index);

  // The card shape and the frozen card lengths describe cards frozen before
  // sections and escaping existed; a current block is split at its headers
  // alone, so a lead plus a following chunk that happen to measure a
  // migrated slug's old card length are never folded together.
  const legacy = options.format === "legacy";
  const cardBytes = legacy ? options.knownCardBytes : undefined;
  const boundaries: Boundary[] = [];
  // The exact end of the open card when its slug's frozen length is on
  // record: the header through that many bytes, measured as the injector
  // measured them. Every candidate starting inside it is card text and the
  // first candidate at it is the next boundary, TOC line or not, which is
  // what covers a sectionless card (no TOC line to close it by shape).
  let openCardEnd: number | null = null;
  for (const [i, candidate] of candidates.entries()) {
    const ref = candidate.ref;
    if (openCardEnd !== null && candidate.index < openCardEnd) {
      continue;
    }
    if (openCardEnd === null || candidate.index !== openCardEnd) {
      const open = boundaries[boundaries.length - 1];
      // Fallback for an open card with no recorded length: it has yet to
      // close when a TOC line lies between this header and the next header
      // the shape reads as opening a chunk on its own; other grammar-shaped
      // lines in between are that card's text too.
      const shapeReadsAsCardText =
        legacy &&
        (ref.kind !== "section" || ref.key.length === 0) &&
        open !== undefined &&
        open.ref.kind === "section" &&
        !shapeOpensChunk(inner, candidate.index) &&
        hasLegacyTocLine(
          inner,
          lineEndAt(inner, candidate.index) + 1,
          candidates
            .slice(i + 1)
            .find((later) => shapeOpensChunk(inner, later.index))?.index ??
            inner.length,
        );
      if (
        shapeReadsAsCardText &&
        !recordedInStore(inner, candidates, i, cardBytes)
      ) {
        continue;
      }
    }
    boundaries.push(candidate);
    openCardEnd =
      ref.kind === "section" && ref.key.length === 0
        ? (recordedSpanEnd(
            inner,
            candidates,
            i,
            cardBytes?.get(ref.slug) ?? 0,
          ) ?? null)
        : null;
  }
  if (boundaries.length === 0) {
    return { preamble: inner, sections: [], pieces: [] };
  }

  const preamble = inner.slice(0, boundaries[0]!.index).trimEnd();
  const pieces = boundaries.map((boundary, i): InjectionBlockPiece => {
    const end =
      i + 1 < boundaries.length ? boundaries[i + 1]!.index : undefined;
    const text = inner.slice(boundary.index, end).trimEnd();
    return { ...boundary.ref, text };
  });
  const sections = pieces.filter(
    (piece): piece is Extract<InjectionBlockPiece, { kind: "section" }> =>
      piece.kind === "section",
  );
  return { preamble, sections, pieces };
}

/**
 * Read a persisted memory-injection block off a message's metadata JSON, or
 * `null` when absent/malformed. `key` selects the injection layer: v2's
 * `memoryInjectedBlock` or memory-v3's section block
 * (`MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`).
 *
 * NOTE: `memory/conversation-crud.ts` carries a private copy of this exact
 * helper (its fork-seeding scan predates this export); consolidating it onto
 * this one is a pending cleanup tracked alongside the prune-valve work.
 */
export function readInjectedBlock(
  metadata: string | null | undefined,
  key: string,
): string | null {
  const block = readInjectedMetadata(metadata)?.[key];
  return typeof block === "string" ? block : null;
}

/** A message's metadata JSON as a record, or `null` when absent or
 *  malformed (anything but a JSON object). */
export function readInjectedMetadata(
  metadata: string | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed metadata: treat as no metadata.
  }
  return null;
}
