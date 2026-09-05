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
 * Kept as a dependency-free leaf (like `memory-marker.ts`) so the
 * conversation-fork path can import it without pulling in the heavyweight
 * injection module.
 */

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

/** Whether the span from candidate `i`'s header to some later candidate
 *  header (or the end of the block), block joiner excluded, is exactly
 *  `recorded` bytes long: the frozen card's own length, so the header is a
 *  real card boundary. Zero (unrecorded) never matches. */
function spanHasRecordedBytes(
  inner: string,
  candidates: Boundary[],
  i: number,
  recorded: number,
): boolean {
  if (recorded <= 0) {
    return false;
  }
  const start = candidates[i]!.index;
  const ends = [
    ...candidates.slice(i + 1).map((candidate) => candidate.index),
    inner.length,
  ];
  return ends.some(
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

export interface ParseInjectedSectionsOptions {
  /** Recorded byte length of each page's frozen lead entry for the
   *  conversation, resident or pruned (`getKnownCardBytes`). For a card
   *  frozen before body escaping it is the exact UTF-8 length that build's
   *  injector measured for the whole card, which migration 378 carried over.
   *  Inside such a card, a concept header on a seam that the card shape reads
   *  as text is a boundary after all when the span from it to a later
   *  candidate header (block joiner excluded) has exactly its slug's recorded
   *  bytes; an unrecorded or zero entry leaves the shape's verdict, never a
   *  bare slug-membership one. Omitted (no conversation at hand): the card
   *  shape alone decides. */
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
 * Blocks frozen by builds before body escaping hold compact cards (concept
 * header, the page head, a blank line, a `[sections: …]` / `[linked: …]` TOC
 * line) whose leads may contain a header-shaped line. Inside such a card, a
 * bare concept header (a lead's; heading-section headers never occur in
 * those blocks) on a seam is read as card text when the card shape says it
 * does not open a card: its next line is neither the page's `# Title` nor a
 * `[current: …]` annotation, the previous content line is not a TOC line
 * (the preceding card is still open), and a TOC line follows before the next
 * candidate header (the open card has yet to close). That verdict is
 * overturned only by exact evidence: when `options.knownCardBytes` records
 * the slug's frozen card length and the span from the header to some later
 * candidate matches it byte for byte, the header is a boundary. Current
 * blocks escape TOC-shaped lines, so neither rule can apply to them.
 */
export function parseInjectedSections(
  inner: string,
  options: ParseInjectedSectionsOptions = {},
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

  const boundaries: Boundary[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const open = boundaries[boundaries.length - 1];
    const ref = candidate.ref;
    const shapeReadsAsCardText =
      ref.kind === "section" &&
      ref.key.length === 0 &&
      open !== undefined &&
      open.ref.kind === "section" &&
      !opensLegacyCard(lineAfter(inner, candidate.index)) &&
      !LEGACY_CARD_TOC_LINE_REGEX.test(
        nonBlankLineBefore(inner, candidate.index) ?? "",
      ) &&
      hasLegacyTocLine(
        inner,
        lineEndAt(inner, candidate.index) + 1,
        candidates[i + 1]?.index ?? inner.length,
      );
    const legacyCardText =
      shapeReadsAsCardText &&
      ref.kind === "section" &&
      !spanHasRecordedBytes(
        inner,
        candidates,
        i,
        options.knownCardBytes?.get(ref.slug) ?? 0,
      );
    if (!legacyCardText) {
      boundaries.push(candidate);
    }
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
  if (!metadata) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const block = (parsed as Record<string, unknown>)[key];
      if (typeof block === "string") {
        return block;
      }
    }
  } catch {
    // Malformed metadata: treat as no block.
  }
  return null;
}
