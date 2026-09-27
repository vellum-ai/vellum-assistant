/**
 * Reader that turns an OOXML workbook (`.xlsx`, `.xlsm`) into one capped grid
 * per sheet for the drawer's read-only preview.
 *
 * Hand-rolled for the same reason `csv.ts` is: the preview needs exactly one
 * shape (a rectangular grid per sheet, capped so a huge export cannot wedge
 * the tab) and none of the writing, formatting, or formula machinery a
 * spreadsheet library carries. Parts are inflated as a stream and abandoned
 * once a cap is met, so a 200 MB workbook costs about what a 5000-row one
 * does. Opening a workbook reads only its metadata; a sheet's own part waits
 * for `WorkbookSheet.read`. A worksheet omits rows that are entirely blank and
 * records where the next one sits, so those gaps are refilled to keep the
 * sheet's layout.
 *
 * @see http://www.ecma-international.org/publications/standards/Ecma-376.htm
 */

import JSZip from "jszip";

import {
  MAX_CSV_ROWS,
  shapeRecords,
  type ParsedCsv,
} from "@/domains/chat/components/local-file/preview/csv";

export interface SheetExtent {
  /** The last row number the sheet's dimension record states. */
  rows: number;
  /** The last column that record names, counted from one. */
  columns: number;
}

export interface SheetGrid extends ParsedCsv {
  /**
   * The used range the sheet states, or `null` when it states none this
   * reader can read. It says how much of the sheet a cut left out and feeds
   * nothing else: a producer may leave the record out, spell it as one cell,
   * or state a range its own cells contradict.
   */
  extent: SheetExtent | null;
}

export interface WorkbookSheet {
  /** Sheet name as the workbook spells it, which is also the tab label. */
  name: string;
  /**
   * This sheet's grid, read on demand. Reads are queued per workbook, newest
   * request first: one sheet part is inflated and parsed at a time, so the
   * tab being looked at waits only on the read already running and the tabs
   * left behind drain one at a time after it. A workbook holds the
   * {@link MAX_CACHED_SHEETS} most recently read grids, so asking again for
   * one of those costs nothing and a failed read of one stays failed, while a
   * sheet crowded out by newer reads is read again. Sheets are lazy because
   * the preview shows one at a time: parsing every sheet when the workbook
   * opens would multiply every cap by the sheet count.
   */
  read(): Promise<SheetGrid>;
}

export interface ParsedWorkbook {
  /** Readers for the first {@link MAX_WORKBOOK_SHEETS} sheets shown. */
  sheets: WorkbookSheet[];
  /** How many sheets the workbook shows, which `sheets` holds the start of. */
  sheetCount: number;
}

const MS_PER_DAY = 86_400_000;

/** Namespace OOXML parts declare for their relationship attributes. */
const RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Highest serial the 1900 date system spells, which is 9999-12-31. */
const MAX_SERIAL_1900 = 2_958_465;

/**
 * The same last day in the 1904 system, whose epoch sits 1462 days later.
 */
const MAX_SERIAL_1904 = MAX_SERIAL_1900 - 1462;

/** Units an elapsed format counts in, largest first. */
const ELAPSED_UNITS = ["hours", "minutes", "seconds"] as const;

type ElapsedUnit = (typeof ELAPSED_UNITS)[number];

/** The unit each elapsed placeholder letter counts in. */
const ELAPSED_UNIT_BY_LETTER: Record<string, ElapsedUnit> = {
  h: "hours",
  m: "minutes",
  s: "seconds",
};

/**
 * The meridiem token a 12-hour format spells, which decides both that the
 * reading runs on a 12-hour clock and what closes it: `AM/PM` spells `AM` or
 * `PM`, `A/P` the single letter.
 */
type Meridiem = "AM/PM" | "A/P";

/**
 * What a cell's number format renders its value as. A clock reading carries
 * whether its format spells a seconds field, since that is what decides the
 * reading's precision rather than the value behind it. An `elapsed` format
 * keeps the whole span it is handed instead of wrapping at midnight, so it
 * carries the units its fields run between: `[h]:mm:ss` runs from hours to
 * seconds, `[mm]:ss` from minutes to seconds.
 */
type NumberFormatKind =
  | { kind: "none" }
  | { kind: "date" }
  | { kind: "time"; seconds: boolean; meridiem: Meridiem | null }
  | { kind: "datetime"; seconds: boolean; meridiem: Meridiem | null }
  | { kind: "elapsed"; from: ElapsedUnit; to: ElapsedUnit };

/** A format that reads a serial as a moment rather than as a number. */
type SerialFormat = Extract<
  NumberFormatKind,
  { kind: "date" | "time" | "datetime" }
>;

/** What a cell renders as when nothing styles it as a date or a duration. */
const PLAIN_NUMBER: NumberFormatKind = { kind: "none" };

/** The built-in ids whose own code spells a seconds field. */
const SECONDS_IN_BUILT_IN = new Set([19, 21, 33, 45, 47]);

/** The built-in ids whose own code spells a meridiem, which is `AM/PM`. */
const MERIDIEM_IN_BUILT_IN = new Set([18, 19]);

/** How a section's condition compares the value against its own number. */
interface FormatCondition {
  operator: string;
  value: number;
}

/** One section of a format code: what selects it, and what it renders. */
interface FormatSection {
  condition: FormatCondition | null;
  kind: NumberFormatKind;
}

/**
 * What a style renders, as the sections of its format code in the order they
 * are spelled. A value picks one of them, by its own condition where the code
 * carries conditions and by its sign where it does not.
 */
type StyleFormat = FormatSection[];

/** What a cell carrying no style, or one that spells no format, renders as. */
const PLAIN_STYLE: StyleFormat = [{ condition: null, kind: PLAIN_NUMBER }];

/**
 * What a built-in `numFmtId` renders. The date ids spell a calendar day, the
 * time ids a clock reading, 22 is the one built-in that spells both, and 46
 * (`[h]:mm:ss`) is the one that counts elapsed hours. Ids 45 (`mm:ss`) and 47
 * (`mmss.0`) read the minutes and seconds of a time of day, so they stay
 * clock readings, and so do the East Asian ids 32 (`h"時"mm"分"`) and 33
 * (`h"時"mm"分"ss"秒"`), which sit between the date ids 27 to 31 and 34 to
 * 36. The ids that spell a seconds field of their own read to the second.
 */
function builtInFormatKind(id: number): NumberFormatKind {
  if (
    (id >= 14 && id <= 17) ||
    (id >= 27 && id <= 31) ||
    (id >= 34 && id <= 36) ||
    (id >= 50 && id <= 58)
  ) {
    return { kind: "date" };
  }
  if (id === 46) {
    return { kind: "elapsed", from: "hours", to: "seconds" };
  }
  if (
    (id >= 18 && id <= 21) ||
    id === 32 ||
    id === 33 ||
    id === 45 ||
    id === 47
  ) {
    return {
      kind: "time",
      seconds: SECONDS_IN_BUILT_IN.has(id),
      meridiem: MERIDIEM_IN_BUILT_IN.has(id) ? "AM/PM" : null,
    };
  }
  return id === 22
    ? { kind: "datetime", seconds: false, meridiem: null }
    : PLAIN_NUMBER;
}

/** Characters that separate format tokens without spelling one. */
const FORMAT_SEPARATOR = /[\s:.,\-/]/;

/**
 * Whether the token reached by walking from `from` in `direction` is an hour
 * or a second, which is what makes Excel read an adjacent `m` as minutes
 * rather than as a month. Separators between the two do not break the pair.
 */
function nextToClockToken(
  code: string,
  from: number,
  direction: 1 | -1,
): boolean {
  for (
    let index = from;
    index >= 0 && index < code.length;
    index += direction
  ) {
    const character = code.charAt(index);
    if (character === "h" || character === "s") {
      return true;
    }
    if (!FORMAT_SEPARATOR.test(character)) {
      return false;
    }
  }
  return false;
}

/** A bracketed section that counts elapsed time instead of a clock reading. */
const ELAPSED_BRACKET = /^\[(h+|m+|s+)\]$/i;

/**
 * The meridiem tokens. Their letters spell no placeholder of their own, and
 * the `m` in each reads as a month beside the `a` or the `p`, which is what
 * would otherwise classify a 12-hour code as a date.
 */
const MERIDIEM = /am\/pm|a\/p/g;

/** The largest of `units`, which is the one `ELAPSED_UNITS` lists first. */
function largestElapsedUnit(units: ReadonlySet<ElapsedUnit>): ElapsedUnit {
  return ELAPSED_UNITS.find((unit) => units.has(unit)) ?? "hours";
}

/** The smallest of `units`, which is the one `ELAPSED_UNITS` lists last. */
function smallestElapsedUnit(units: ReadonlySet<ElapsedUnit>): ElapsedUnit {
  let smallest: ElapsedUnit = "hours";
  for (const unit of ELAPSED_UNITS) {
    if (units.has(unit)) {
      smallest = unit;
    }
  }
  return smallest;
}

/**
 * The sections of `code`, which a cell picks one of by value. A quoted
 * literal, a bracket, and a backslash escape can each hold a `;` that separates
 * nothing.
 */
function formatSections(code: string): string[] {
  const sections: string[] = [];
  let quoted = false;
  let bracketed = false;
  let from = 0;
  let index = 0;
  while (index < code.length) {
    const character = code.charAt(index);
    if (quoted) {
      quoted = character !== '"';
    } else if (bracketed) {
      bracketed = character !== "]";
    } else if (character === "\\") {
      index += 1;
    } else if (character === '"') {
      quoted = true;
    } else if (character === "[") {
      bracketed = true;
    } else if (character === ";") {
      sections.push(code.slice(from, index));
      from = index + 1;
    }
    index += 1;
  }
  sections.push(code.slice(from));
  return sections;
}

/**
 * What one section of a format code renders. Quoted literals, bracketed
 * sections, the meridiem tokens, and the directives that carry the character
 * after them (`\` escapes it, `_` spaces the width of it, `*` fills with it)
 * can each hold a letter that spells no placeholder, so they come out
 * before the placeholders are read: a meridiem leaves a clock reading behind
 * it, a colour or locale bracket leaves nothing, and a bracket spelling
 * nothing but `h`, `m`, or `s` makes the section elapsed time, counted from
 * its largest bracketed unit down to the smallest unit it spells.
 */
function formatCodeKind(code: string): NumberFormatKind {
  const bracketed = new Set<ElapsedUnit>();
  const placeholders = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, (section) => {
      const elapsed = ELAPSED_BRACKET.exec(section);
      if (elapsed !== null) {
        bracketed.add(
          ELAPSED_UNIT_BY_LETTER[elapsed[1]!.charAt(0).toLowerCase()]!,
        );
      }
      return "";
    })
    .replace(/[\\_*]./g, "")
    .toLowerCase();
  const tokens = placeholders.replace(MERIDIEM, "");
  if (bracketed.size > 0) {
    const spelled = new Set(bracketed);
    for (const [letter, unit] of Object.entries(ELAPSED_UNIT_BY_LETTER)) {
      if (tokens.includes(letter)) {
        spelled.add(unit);
      }
    }
    return {
      kind: "elapsed",
      from: largestElapsedUnit(bracketed),
      to: smallestElapsedUnit(spelled),
    };
  }
  const meridiemToken = placeholders.match(MERIDIEM)?.[0] ?? null;
  const meridiem: Meridiem | null =
    meridiemToken === null ? null : meridiemToken === "a/p" ? "A/P" : "AM/PM";
  let hasDate = /[yd]/.test(tokens);
  let hasTime = meridiem !== null || /[hs]/.test(tokens);
  for (const run of tokens.matchAll(/m+/g)) {
    const start = run.index;
    const end = start + run[0].length;
    if (
      nextToClockToken(tokens, start - 1, -1) ||
      nextToClockToken(tokens, end, 1)
    ) {
      hasTime = true;
    } else {
      hasDate = true;
    }
  }
  const seconds = /s/.test(tokens);
  if (hasDate) {
    return hasTime ? { kind: "datetime", seconds, meridiem } : { kind: "date" };
  }
  return hasTime ? { kind: "time", seconds, meridiem } : PLAIN_NUMBER;
}

/**
 * A section's own condition, such as the `[>=100]` a section applying to
 * hundreds and up opens with. The comparisons are spelled longest first so
 * `[<=1]` reads as `<=` rather than as `<`. A colour or locale bracket sits in
 * the same place and spells no comparison, so neither reads as a condition.
 */
const FORMAT_CONDITION = /\[(<=|>=|<>|<|>|=)(-?\d+(?:\.\d+)?)\]/;

/** What a custom format code renders, section by section. */
function formatCodeStyle(code: string): StyleFormat {
  return formatSections(code).map((section) => {
    const condition = FORMAT_CONDITION.exec(section);
    return {
      condition:
        condition === null
          ? null
          : { operator: condition[1]!, value: Number(condition[2]) },
      // The condition spells no placeholder, so the kind is read from what is
      // left once it is out.
      kind: formatCodeKind(section.replace(FORMAT_CONDITION, "")),
    };
  });
}

/** Whether `value` is what `condition` asks for. */
function conditionHolds(condition: FormatCondition, value: number): boolean {
  switch (condition.operator) {
    case "<":
      return value < condition.value;
    case "<=":
      return value <= condition.value;
    case ">":
      return value > condition.value;
    case ">=":
      return value >= condition.value;
    case "<>":
      return value !== condition.value;
    default:
      return value === condition.value;
  }
}

/**
 * The kind `value` renders as under `style`. A code that carries conditions
 * selects by them, falling back to the section that carries none and then to
 * the last one. A code that carries none selects by sign: Excel holds the zero
 * rendering in the third section, so a code of one or two sections renders
 * zero the way it renders a positive value.
 */
function selectFormatKind(style: StyleFormat, value: number): NumberFormatKind {
  if (!style.some((section) => section.condition !== null)) {
    const section = value === 0 && style.length > 2 ? style[2] : style[0];
    return section?.kind ?? PLAIN_NUMBER;
  }
  const selected =
    style.find(
      (section) =>
        section.condition !== null && conditionHolds(section.condition, value),
    ) ??
    style.find((section) => section.condition === null) ??
    style[style.length - 1];
  return selected?.kind ?? PLAIN_NUMBER;
}

/** Local part of a qualified name, so `rel:id` and `id` both read as `id`. */
function localPart(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Direct children of `parent` with this local name. A producer picks its own
 * OOXML prefixes, so nothing can be matched by qualified name. Every element
 * this reader wants is a direct child of the one above it, and staying on that
 * one level keeps a 5000 by 200 sheet off the cost of a descendant scan per
 * row and per cell.
 */
function directChildrenNamed(parent: Element, localName: string): Element[] {
  const children = parent.children;
  const matched: Element[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);
    if (child !== null && localPart(child.localName) === localName) {
      matched.push(child);
    }
  }
  return matched;
}

/**
 * The first direct child of `parent` with this local name. A cell asks for its
 * `<v>` and `<f>` a million times over a full grid, so this one walks without
 * building a list.
 */
function firstChildNamed(
  parent: Element,
  localName: string,
): Element | undefined {
  const children = parent.children;
  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);
    if (child !== null && localPart(child.localName) === localName) {
      return child;
    }
  }
  return undefined;
}

/**
 * The first element at or under `root` with this local name, which is how a
 * part's one container (`sst`, `sheetData`, `cellXfs`) is found wherever its
 * producer nests it. Stopping at the first match keeps the cost off the size
 * of the part, which collecting every descendant would not.
 */
function findNamed(root: Element, localName: string): Element | undefined {
  if (localPart(root.localName) === localName) {
    return root;
  }
  const children = root.children;
  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);
    const found = child === null ? undefined : findNamed(child, localName);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * An attribute's value by local name, whatever prefix carries it. The
 * attribute declared in `namespaceUri` wins, and a bare local-name match is
 * the fallback: happy-dom reports no namespace on an attribute and leaves the
 * prefix on its `localName`.
 */
function attributeNamed(
  element: Element,
  localName: string,
  namespaceUri: string,
): string | null {
  let fallback: string | null = null;
  for (const attribute of Array.from(element.attributes)) {
    if (localPart(attribute.localName) !== localName) {
      continue;
    }
    if (attribute.namespaceURI === namespaceUri) {
      return attribute.value;
    }
    fallback ??= attribute.value;
  }
  return fallback;
}

/**
 * jszip inflates one entry lazily through `internalStream`, which its bundled
 * `index.d.ts` leaves out.
 */
type StreamingEntry = JSZip.JSZipObject & {
  internalStream(type: "string"): JSZip.JSZipStreamHelper<string>;
};

/**
 * Parse an OOXML part. Browsers report a bad document as a `parsererror`
 * element rather than by throwing, so the check has to be explicit.
 */
function parseXml(xml: string, part: string): Element {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`Malformed XML in ${part}`);
  }
  return doc.documentElement;
}

/**
 * Hard cap on the characters inflated from a single part. The row cap bounds
 * how much of a grid is kept; this bounds a part that inflates far past its
 * compressed size, which is what a DEFLATE bomb does and what one enormous
 * cell or shared string does by accident. It covers the metadata parts too
 * (`xl/workbook.xml`, its relationships, and `xl/styles.xml`), which are only
 * useful whole and so are rejected at the cap rather than cut. A full 5000 by
 * 200 grid of ordinary cells sits well under it.
 */
const MAX_PART_CHARS = 64 * 1024 * 1024;

/**
 * How many cells of one sheet are read. A cell costs three nodes in the DOM a
 * part is parsed into (the cell, its value, and the text inside it), and the
 * grid it becomes is held for as many as {@link MAX_CACHED_SHEETS} sheets, so
 * the row and column caps alone would let one sheet build millions of them
 * for a preview that shows a screenful. The rows past the budget are never
 * inflated.
 */
export const MAX_SHEET_CELLS = 250_000;

/**
 * How many columns of a row are kept. Rows are virtualized and columns are
 * not, so this is what bounds the cells a visible row builds.
 */
export const MAX_SHEET_COLUMNS = 1000;

/**
 * How many entries a container the preview opens may hold. A workbook carries
 * a part per sheet plus a handful for its drawings, tables, and images, so a
 * real one sits far under this, while a directory of a hundred thousand costs
 * the zip reader an entry apiece before any workbook limit has run.
 */
export const MAX_ZIP_ENTRIES = 10_000;

/** Signature the end of central directory record opens with. */
const ZIP_DIRECTORY_END = 0x06054b50;

/** Bytes that record holds, before the comment it can carry. */
const ZIP_DIRECTORY_END_BYTES = 22;

/** Signature each central file header opens with. */
const ZIP_CENTRAL_HEADER = 0x02014b50;

/** Bytes that header holds, before the name, extra, and comment it carries. */
const ZIP_CENTRAL_HEADER_BYTES = 46;

/** The values a record spells when its real ones live in a ZIP64 record. */
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffff_ffff;

/** Whether `signature` sits at `at`, which the end of the bytes rules out. */
function signatureAt(view: DataView, at: number, signature: number): boolean {
  return (
    at >= 0 &&
    at + 4 <= view.byteLength &&
    view.getUint32(at, true) === signature
  );
}

/** Where `signature` sits last in `bytes`, which is where the reader looks. */
function lastSignatureAt(bytes: Uint8Array, signature: number): number {
  const first = signature & 0xff;
  const second = (signature >> 8) & 0xff;
  const third = (signature >> 16) & 0xff;
  const fourth = (signature >>> 24) & 0xff;
  for (let at = bytes.length - 4; at >= 0; at -= 1) {
    if (
      bytes[at] === first &&
      bytes[at + 1] === second &&
      bytes[at + 2] === third &&
      bytes[at + 3] === fourth
    ) {
      return at;
    }
  }
  return -1;
}

/**
 * How many entries the zip reader would take out of these bytes, which is not
 * the count the container declares: the walk follows the reader's own. It
 * takes the last end of central directory record in the file, shifts every
 * offset by the bytes sitting in front of the directory the way the reader
 * does, and then counts central file headers from there for as long as their
 * signature holds. Counting stops once it passes `cap`, so a crafted
 * directory costs the cap rather than its own length. `null` leaves the file
 * to the reader to turn down itself, and a ZIP64 container, whose real bounds
 * sit in a record of its own, counts as past the cap: it holds more entries
 * than a preview opens or is larger than one reads.
 */
function zipEntryCount(bytes: ArrayBuffer, cap: number): number | null {
  const data = new Uint8Array(bytes);
  const view = new DataView(bytes);
  const at = lastSignatureAt(data, ZIP_DIRECTORY_END);
  if (at < 0 || at + ZIP_DIRECTORY_END_BYTES > data.length) {
    return null;
  }
  const size = view.getUint32(at + 12, true);
  const offset = view.getUint32(at + 16, true);
  if (
    view.getUint16(at + 4, true) === MAX_UINT16 ||
    view.getUint16(at + 6, true) === MAX_UINT16 ||
    view.getUint16(at + 8, true) === MAX_UINT16 ||
    view.getUint16(at + 10, true) === MAX_UINT16 ||
    size === MAX_UINT32 ||
    offset === MAX_UINT32
  ) {
    return cap + 1;
  }
  const directoryEnds = offset + size;
  if (at < directoryEnds) {
    // The reader turns down a record sitting in front of the directory it
    // names, so the file is its to report on.
    return null;
  }
  // Bytes in front of the directory shift every offset it holds, unless a
  // header already sits where the record says the directory ends.
  const shift = signatureAt(view, at, ZIP_CENTRAL_HEADER)
    ? 0
    : at - directoryEnds;
  let scan = shift + offset;
  let entries = 0;
  while (
    scan + ZIP_CENTRAL_HEADER_BYTES <= data.length &&
    signatureAt(view, scan, ZIP_CENTRAL_HEADER)
  ) {
    entries += 1;
    if (entries > cap) {
      return entries;
    }
    scan +=
      ZIP_CENTRAL_HEADER_BYTES +
      view.getUint16(scan + 28, true) +
      view.getUint16(scan + 30, true) +
      view.getUint16(scan + 32, true);
  }
  return entries;
}

/**
 * How much inflated text a streamed read takes in before it looks at it.
 * Reading is linear in the size of a part, and a batch this size keeps the
 * cost of handing it over linear too, while a read that stops early still
 * abandons the rest of the stream within a batch of doing so.
 */
const STREAM_BATCH_CHARS = 4 * 1024 * 1024;

/**
 * How many shared strings a workbook holds on to between sheet reads. One
 * grid can point at as many as {@link MAX_SHEET_CELLS} of them, so a sheet's
 * worth is what makes tabbing back and forth free: past that the strings read
 * longest ago go, and a sheet that wants them again reads them again.
 */
const MAX_CACHED_STRINGS = MAX_SHEET_CELLS;

interface BoundedPart {
  xml: string;
  /** True when the read stopped before the end of the part. */
  truncated: boolean;
  /**
   * Qualified name of each element left open at the cut, innermost first and
   * spelled the way the part itself opened it.
   */
  stillOpen: string[];
}

/** The repeating element a bounded read counts, by local name. */
interface PartMarker {
  localName: string;
  limit: number;
  /**
   * A second element counted across the markers. Passing its limit cuts the
   * read at the marker it was passed under, so what is kept holds no more of
   * them than the limit.
   */
  budget?: { localName: string; limit: number };
}

/**
 * Whether `character` ends an element's name, as the one after `<row` does in
 * `<row>`, `<row/>`, and `<row r="1">`. Without this the marker would also
 * count the `<rowBreaks>` section a worksheet writes after its rows, and cut
 * the part after `</sheetData>` had already closed.
 */
function endsTagName(character: string): boolean {
  return character === ">" || character === "/" || /\s/.test(character);
}

/**
 * Whether `character` carries an element's name on. A name runs until
 * something ends it, splits it, or opens the next tag, which is what carries
 * the scan across a prefix spelled in any script: XML allows name characters
 * far outside ASCII, and all this scan needs from a prefix is the `:` that
 * closes it.
 */
function isNameCharacter(character: string): boolean {
  return !endsTagName(character) && character !== ":" && character !== "<";
}

/** How a `<` reads against the marker a bounded read is counting. */
type StartTagMatch =
  | { kind: "match"; prefix: string }
  | { kind: "other" }
  | { kind: "pending" };

const OTHER_TAG: StartTagMatch = { kind: "other" };
const PENDING_TAG: StartTagMatch = { kind: "pending" };

/**
 * Whether the `<` at `at` opens a start tag for `localName`. A producer picks
 * its own prefixes, so any prefix is skipped and only the local name is
 * compared, and the character after the name must end it so `<rowBreaks>` does
 * not read as `<row>`. `pending` means the buffer runs out mid-decision, so
 * the next chunk settles it rather than this one guessing.
 */
function matchStartTag(
  buffer: string,
  at: number,
  localName: string,
): StartTagMatch {
  const nameAt = at + 1;
  let scan = nameAt;
  while (scan < buffer.length && isNameCharacter(buffer.charAt(scan))) {
    scan += 1;
  }
  if (scan === buffer.length) {
    return PENDING_TAG;
  }
  const prefix =
    scan > nameAt && buffer.charAt(scan) === ":"
      ? buffer.slice(nameAt, scan + 1)
      : "";
  const start = nameAt + prefix.length;
  const end = start + localName.length;
  if (buffer.length <= end) {
    return PENDING_TAG;
  }
  if (
    buffer.slice(start, end) !== localName ||
    !endsTagName(buffer.charAt(end))
  ) {
    return OTHER_TAG;
  }
  return { kind: "match", prefix };
}

/**
 * Whether the `<` at `at` closes an element named `localName`. A prefix is
 * skipped the way {@link matchStartTag} skips it, so `</x:row>` and `</row>`
 * both close a row, while `</rowBreaks>` closes neither.
 */
function matchEndTag(buffer: string, at: number, localName: string): boolean {
  if (buffer.charAt(at + 1) !== "/") {
    return false;
  }
  const nameAt = at + 2;
  let scan = nameAt;
  while (scan < buffer.length && isNameCharacter(buffer.charAt(scan))) {
    scan += 1;
  }
  const start =
    scan > nameAt && buffer.charAt(scan) === ":" ? scan + 1 : nameAt;
  const end = start + localName.length;
  return (
    buffer.slice(start, end) === localName && endsTagName(buffer.charAt(end))
  );
}

/** Constructs that carry text spelling tags of their own, by how each closes. */
const NON_TAG_CONSTRUCTS = [
  { opens: "<![CDATA[", closes: "]]>" },
  { opens: "<!--", closes: "-->" },
  { opens: "<?", closes: "?>" },
];

/** How a `<` reads against those constructs. */
type NonTagMatch =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "skip"; to: number };

const NO_CONSTRUCT: NonTagMatch = { kind: "none" };
const PENDING_CONSTRUCT: NonTagMatch = { kind: "pending" };

/**
 * Whether the `<` at `at` opens one of those constructs, and where it ends. A
 * scan over markup steps past one whole, since the `<c>` an inline string
 * holds inside CDATA opens no cell. `pending` means the buffer runs out before
 * the opener or its closer settles, so the next chunk decides it rather than
 * this one guessing.
 */
function matchNonTag(buffer: string, at: number): NonTagMatch {
  for (const { opens, closes } of NON_TAG_CONSTRUCTS) {
    const available = buffer.length - at;
    if (available < opens.length) {
      if (buffer.startsWith(opens.slice(0, available), at)) {
        return PENDING_CONSTRUCT;
      }
      continue;
    }
    if (buffer.startsWith(opens, at)) {
      const ends = buffer.indexOf(closes, at + opens.length);
      return ends < 0
        ? PENDING_CONSTRUCT
        : { kind: "skip", to: ends + closes.length };
    }
  }
  return NO_CONSTRUCT;
}

/**
 * The same reading over a complete string: where the construct opened by the
 * `<` at `at` ends, or -1 when that `<` opens an ordinary tag. Nothing is left
 * to arrive, so a construct that never closes runs to the end of the string.
 */
function skipNonTag(buffer: string, at: number): number {
  const match = matchNonTag(buffer, at);
  if (match.kind === "none") {
    return -1;
  }
  return match.kind === "skip" ? match.to : buffer.length;
}

/**
 * Where the element holding the `<` at `at` closes, or the end of `xml` when
 * it never does. The elements scanned for this way never nest inside
 * themselves, so the first end tag of that name is the one that closes them.
 */
function findEndTag(xml: string, at: number, localName: string): number {
  let scan = xml.indexOf("<", at);
  while (scan >= 0) {
    const pastConstruct = skipNonTag(xml, scan);
    if (pastConstruct >= 0) {
      scan = xml.indexOf("<", pastConstruct);
      continue;
    }
    if (matchEndTag(xml, scan, localName)) {
      return scan;
    }
    scan = xml.indexOf("<", scan + 1);
  }
  return xml.length;
}

/**
 * Where the element opened at `at` ends, past its close tag or past a
 * self-closing start tag, and the end of `xml` when it never closes. A cut
 * here keeps the element whole and leaves out the markup after it, which
 * belongs to another element.
 */
function elementEndsAt(xml: string, at: number, localName: string): number {
  const opening = tagEndsAt(xml, at);
  if (opening < 0) {
    return xml.length;
  }
  if (xml.charAt(opening - 1) === "/") {
    return opening + 1;
  }
  const closesAt = findEndTag(xml, at, localName);
  if (closesAt >= xml.length) {
    return xml.length;
  }
  const closeEnds = tagEndsAt(xml, closesAt);
  return closeEnds < 0 ? xml.length : closeEnds + 1;
}

/**
 * Where the tag opened at `at` ends. XML allows an unescaped `>` inside an
 * attribute value, so the scan runs past whatever a quoted value holds.
 */
function tagEndsAt(xml: string, at: number): number {
  let quote = "";
  for (let index = at + 1; index < xml.length; index += 1) {
    const character = xml.charAt(index);
    if (quote !== "") {
      if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      return index;
    }
  }
  return -1;
}

/** The qualified name a start tag opens, spelled the way the tag spells it. */
function tagName(tag: string): string {
  let scan = 1;
  while (scan < tag.length && !endsTagName(tag.charAt(scan))) {
    scan += 1;
  }
  return tag.slice(1, scan);
}

/** A part's root element: its start tag, and the name that closes it. */
function firstStartTag(xml: string): { tag: string; name: string } | null {
  let at = xml.indexOf("<");
  while (at >= 0) {
    const pastConstruct = skipNonTag(xml, at);
    if (pastConstruct >= 0) {
      at = xml.indexOf("<", pastConstruct);
      continue;
    }
    if (xml.charAt(at + 1) === "/") {
      return null;
    }
    const end = tagEndsAt(xml, at);
    if (end < 0) {
      return null;
    }
    const tag = xml.slice(at, end + 1);
    return { tag, name: tagName(tag) };
  }
  return null;
}

const ATTRIBUTE_PATTERNS = new Map<string, RegExp>();

/**
 * An attribute's value inside a start tag's own text. The attributes read this
 * way (`state`, `Id`, `Type`) spell no entity, so the value stands as it is
 * written.
 */
function attributeInTag(tag: string, name: string): string | null {
  let pattern = ATTRIBUTE_PATTERNS.get(name);
  if (pattern === undefined) {
    pattern = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`);
    ATTRIBUTE_PATTERNS.set(name, pattern);
  }
  const match = pattern.exec(tag);
  return match === null ? null : match[1]!.slice(1, -1);
}

/** The elements one capture takes out of a part. */
interface CaptureSpec {
  /** Local name of the elements to take. */
  localName: string;
  /** Local name of the element they sit inside, when they sit in one. */
  container?: string;
  /** Whether the element whose start tag is `tag` is one the reader wants. */
  keep?: (tag: string) => boolean;
  /** How many to take at most. Counting carries on past it. */
  limit: number;
}

/** What one capture found. */
interface CaptureResult {
  /** How many elements sit in its scope. */
  seen: number;
  /** How many of them `keep` wants. */
  matched: number;
  /** How many of those the document holds, which the limit caps. */
  kept: number;
}

interface CapturedPart {
  /** A document holding the kept elements, or `null` for a rootless part. */
  xml: string | null;
  /** One result per capture, in the order they were asked for. */
  results: CaptureResult[];
}

/** The elements one capture keeps, and what its scope holds. */
interface CapturedElements extends CaptureResult {
  /** The container start tag, the kept elements, and the container end tag. */
  body: string;
}

function captureOne(xml: string, spec: CaptureSpec): CapturedElements {
  const spans: string[] = [];
  // A container sits directly under the root, and the elements it holds
  // directly under itself.
  const itemDepth = spec.container === undefined ? 1 : 2;
  // Qualified name of each element open around the scan, so an element left
  // open inside a block the reader skips cannot carry that depth onwards.
  const open: string[] = [];
  let containerTag = "";
  let containerName = "";
  let inScope = spec.container === undefined;
  let seen = 0;
  let matched = 0;
  let kept = 0;
  let at = xml.indexOf("<");
  while (at >= 0) {
    const pastConstruct = skipNonTag(xml, at);
    if (pastConstruct >= 0) {
      at = xml.indexOf("<", pastConstruct);
      continue;
    }
    const end = tagEndsAt(xml, at);
    if (end < 0) {
      break;
    }
    if (xml.charAt(at + 1) === "/") {
      // An end tag closes the element it names and everything left open
      // inside it.
      const closed = open.lastIndexOf(xml.slice(at + 2, end).trim());
      if (closed >= 0) {
        open.length = closed;
      }
      if (inScope && spec.container !== undefined && open.length < itemDepth) {
        break;
      }
      at = xml.indexOf("<", end + 1);
      continue;
    }
    const opensLevel = xml.charAt(end - 1) !== "/";
    if (spec.container !== undefined && !inScope && open.length === 1) {
      const opened = matchStartTag(xml, at, spec.container);
      if (opened.kind === "match") {
        containerTag = xml.slice(at, end + 1);
        // A container spelled shut holds nothing, and closes itself.
        if (!opensLevel) {
          break;
        }
        containerName = `${opened.prefix}${spec.container}`;
        inScope = true;
        open.push(containerName);
        at = xml.indexOf("<", end + 1);
        continue;
      }
    }
    if (
      inScope &&
      open.length === itemDepth &&
      matchStartTag(xml, at, spec.localName).kind === "match"
    ) {
      const tag = xml.slice(at, end + 1);
      const spansTo = elementEndsAt(xml, at, spec.localName);
      seen += 1;
      if (spec.keep === undefined || spec.keep(tag)) {
        matched += 1;
        if (kept < spec.limit) {
          spans.push(xml.slice(at, spansTo));
          kept += 1;
        }
      }
      // The span holds the element whole, so it leaves nothing open.
      at = xml.indexOf("<", spansTo);
      continue;
    }
    if (opensLevel) {
      open.push(tagName(xml.slice(at, end + 1)));
    }
    at = xml.indexOf("<", end + 1);
  }
  const body =
    containerTag === ""
      ? spans.join("")
      : `${containerTag}${spans.join("")}${
          containerName === "" ? "" : `</${containerName}>`
        }`;
  return { body, seen, matched, kept };
}

/**
 * A small document holding only the elements `specs` ask for, spelled the way
 * the part spells them: its root start tag, each capture's container and the
 * elements it kept, and the closing tags. A metadata part can declare hundreds
 * of thousands of elements inside the character cap, and a DOM that size costs
 * the browser before the preview shows anything, so the reader parses what it
 * reads rather than the part around it. What it takes are direct children of
 * the root, or of a container that is one, because an extension list carries
 * elements of any origin spelled with the same local names.
 */
function captureElements(xml: string, specs: CaptureSpec[]): CapturedPart {
  const root = firstStartTag(xml);
  const captured = specs.map((spec) => captureOne(xml, spec));
  const results = captured.map(({ seen, matched, kept }) => ({
    seen,
    matched,
    kept,
  }));
  if (root === null) {
    return { xml: null, results };
  }
  // A root spelled shut holds none of them.
  if (root.tag.endsWith("/>")) {
    return { xml: root.tag, results };
  }
  const body = captured.map((capture) => capture.body).join("");
  return { xml: `${root.tag}${body}</${root.name}>`, results };
}

/** How a chunk handler ends a streamed read before the part runs out. */
interface Settle<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface StreamedRead<T> {
  /** Called with everything read so far, once per inflated chunk. */
  onChunk(buffer: string, settle: Settle<T>): void;
  /** Called when the part runs out without the read having settled. */
  onEnd(buffer: string): T;
}

/**
 * Inflate `entry` as a stream, handing `read` what has arrived once it reaches
 * `batchChars` and again at the end. Settling from a batch abandons the rest
 * of the stream, which is what lets a caller stop at a cap instead of
 * decompressing a part whole. Batching is what keeps that linear: a reader
 * scans what it is handed from where it left off, so appending every inflate
 * chunk to the buffer and handing it over flattens the whole of it per chunk,
 * which a part of any size pays for many times over.
 */
function streamPart<T>(
  entry: JSZip.JSZipObject,
  read: StreamedRead<T>,
  batchChars: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const stream = (entry as StreamingEntry).internalStream("string");
    let buffer = "";
    let pending: string[] = [];
    let pendingChars = 0;
    let settled = false;
    const flush = (): void => {
      if (pendingChars === 0) {
        return;
      }
      buffer += pending.join("");
      pending = [];
      pendingChars = 0;
    };
    const settle: Settle<T> = {
      resolve: (value) => {
        settled = true;
        stream.pause();
        resolve(value);
      },
      reject: (error) => {
        settled = true;
        stream.pause();
        reject(error);
      },
    };

    stream.on("data", (chunk) => {
      if (settled) {
        return;
      }
      pending.push(chunk);
      pendingChars += chunk.length;
      if (pendingChars < batchChars) {
        return;
      }
      flush();
      read.onChunk(buffer, settle);
    });
    stream.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    stream.on("end", () => {
      if (settled) {
        return;
      }
      // The last batch reaches the reader before the end does, so a reader
      // that settles on what it holds has seen all of it.
      flush();
      read.onChunk(buffer, settle);
      if (!settled) {
        settled = true;
        resolve(read.onEnd(buffer));
      }
    });
    stream.resume();
  });
}

/**
 * Inflate `entry` whole, rejecting once it passes `maxChars`. A part read this
 * way steers every later read, so there is nowhere safe to cut it: a cut
 * workbook or style table is worse than no preview at all.
 */
function readWholePart(
  entry: JSZip.JSZipObject,
  maxChars: number,
  batchChars: number,
): Promise<string> {
  const read: StreamedRead<string> = {
    onChunk: (buffer, settle) => {
      if (buffer.length > maxChars) {
        settle.reject(new Error(`${entry.name} is too large to read`));
      }
    },
    onEnd: (buffer) => buffer,
  };
  return streamPart(entry, read, batchChars);
}

/**
 * Inflate `entry` only until `marker` has been seen past its limit, its budget
 * has been counted past its own, or the text passes `maxChars`, then cut it
 * there and abandon the rest of the stream.
 * A cut past the first marker lands on the `<` of a marker, so the text ends
 * on a complete element; a budget cut inside the first lands on the `<` of the
 * counted element, which leaves that marker open ahead of the ancestors.
 * `stillOpen` names everything the cut leaves open, innermost first. This is
 * what keeps a sheet with a million rows from being decompressed whole for a
 * preview that shows five thousand. A cap reached before a second marker
 * would leave nothing complete behind, so the read rejects rather than
 * resolving a part that reads as empty.
 */
function readMarkedPart(
  entry: JSZip.JSZipObject,
  marker: PartMarker,
  ancestors: string[],
  maxChars: number,
  batchChars: number,
): Promise<BoundedPart> {
  let searchFrom = 0;
  let seen = 0;
  let budgetSeen = 0;
  let lastMarkerAt = -1;
  let lastMarkerPrefix = "";
  // Every ancestor opens before the first marker, so the scan has each one's
  // own spelling in hand by the time a cut needs to close it. The marker's
  // prefix is the fallback for an ancestor the scan never reached.
  const unseen = [...ancestors];
  const openedAs = new Map<string, string>();
  const stillOpen = (): string[] =>
    ancestors.map((name) => openedAs.get(name) ?? `${lastMarkerPrefix}${name}`);

  const read: StreamedRead<BoundedPart> = {
    onChunk: (buffer, settle) => {
      for (;;) {
        const at = buffer.indexOf("<", searchFrom);
        if (at === -1) {
          searchFrom = buffer.length;
          break;
        }
        const construct = matchNonTag(buffer, at);
        if (construct.kind === "pending") {
          // The characters that would close this construct have not arrived,
          // so the next chunk reads it rather than this one counting the
          // markers its text spells.
          searchFrom = at;
          break;
        }
        if (construct.kind === "skip") {
          searchFrom = construct.to;
          continue;
        }
        const match = matchStartTag(buffer, at, marker.localName);
        if (match.kind === "pending") {
          // The characters that would settle this match have not arrived, so
          // the next chunk decides it rather than this one guessing.
          searchFrom = at;
          break;
        }
        searchFrom = at + 1;
        if (match.kind === "other") {
          // A tag the marker ruled out may still be an ancestor: the marker's
          // shorter name settles against a buffer that stops partway through
          // the longer one. A pending ancestor leaves this `<` for the next
          // chunk to decide, rather than losing the spelling a cut closes it
          // with.
          let pendingAncestor = false;
          for (let index = 0; index < unseen.length; index += 1) {
            const name = unseen[index]!;
            const opened = matchStartTag(buffer, at, name);
            if (opened.kind === "match") {
              openedAs.set(name, `${opened.prefix}${name}`);
              unseen.splice(index, 1);
              pendingAncestor = false;
              break;
            }
            if (opened.kind === "pending") {
              pendingAncestor = true;
            }
          }
          if (pendingAncestor) {
            searchFrom = at;
            break;
          }
          if (marker.budget !== undefined) {
            const counted = matchStartTag(buffer, at, marker.budget.localName);
            if (counted.kind === "pending") {
              searchFrom = at;
              break;
            }
            if (counted.kind === "match") {
              budgetSeen += 1;
              // Past the first marker the cut lands on the marker this one was
              // counted under, so the row that passes the budget is left out
              // whole. Inside the first there is no whole marker to keep, so
              // the cut lands on this cell and the marker holding it is closed
              // along with the ancestors.
              if (budgetSeen > marker.budget.limit && seen >= 1) {
                const wholeMarker = seen >= 2;
                settle.resolve({
                  xml: buffer.slice(0, wholeMarker ? lastMarkerAt : at),
                  truncated: true,
                  stillOpen: wholeMarker
                    ? stillOpen()
                    : [
                        `${lastMarkerPrefix}${marker.localName}`,
                        ...stillOpen(),
                      ],
                });
                return;
              }
            }
          }
          continue;
        }
        seen += 1;
        lastMarkerAt = at;
        lastMarkerPrefix = match.prefix;
        if (seen > marker.limit) {
          settle.resolve({
            xml: buffer.slice(0, at),
            truncated: true,
            stillOpen: stillOpen(),
          });
          return;
        }
      }
      if (buffer.length <= maxChars) {
        return;
      }
      if (seen < 2) {
        // Cutting at the only marker seen keeps none of them, which reads as
        // an empty sheet rather than as the unreadable part it is.
        settle.reject(new Error(`${entry.name} is too large to read`));
        return;
      }
      settle.resolve({
        xml: buffer.slice(0, lastMarkerAt),
        truncated: true,
        stillOpen: stillOpen(),
      });
    },
    onEnd: (buffer) => ({ xml: buffer, truncated: false, stillOpen: [] }),
  };
  return streamPart(entry, read, batchChars);
}

/** A metadata part read whole, or `null` when the workbook leaves it out. */
async function readPart(
  zip: JSZip,
  path: string,
  maxChars: number,
  batchChars: number,
): Promise<string | null> {
  const entry = zip.file(path);
  return entry === null ? null : readWholePart(entry, maxChars, batchChars);
}

/**
 * XML for a part a bounded read may have cut. A cut lands at the start of an
 * element, so the elements still open around it are closed again, innermost
 * first and spelled the way the part opened them.
 */
function closeBoundedPart(part: BoundedPart): string {
  if (!part.truncated) {
    return part.xml;
  }
  const closing = part.stillOpen.map((name) => `</${name}>`).join("");
  return `${part.xml}${closing}`;
}

interface SheetRef {
  name: string;
  relationshipId: string | null;
}

interface WorkbookStructure {
  /** The sheets the preview shows, capped at {@link MAX_WORKBOOK_SHEETS}. */
  sheets: SheetRef[];
  /** How many sheets it would show, which `sheets` holds the start of. */
  sheetCount: number;
  date1904: boolean;
}

/** Whether a sheet declaration's own tag says the workbook hides it. */
function declaresHidden(tag: string): boolean {
  const state = attributeInTag(tag, "state");
  return state === "hidden" || state === "veryHidden";
}

/** The captures that hold a workbook part's date mode and its sheet list. */
function workbookCaptures(keep?: (tag: string) => boolean): CaptureSpec[] {
  return [
    { localName: "workbookPr", limit: 1 },
    {
      localName: "sheet",
      container: "sheets",
      keep,
      limit: MAX_WORKBOOK_SHEETS,
    },
  ];
}

function readWorkbookStructure(
  xml: string,
  partPath: string,
): WorkbookStructure {
  const shown = captureElements(
    xml,
    workbookCaptures((tag) => !declaresHidden(tag)),
  );
  // A workbook whose sheets are every one hidden still has something to show.
  const captured =
    shown.results[1]!.matched > 0
      ? shown
      : captureElements(xml, workbookCaptures());
  const sheetCount = captured.results[1]!.matched;
  const root = captured.xml === null ? null : parseXml(captured.xml, partPath);
  const sheetList = root === null ? undefined : findNamed(root, "sheets");
  const listed =
    sheetList === undefined ? [] : directChildrenNamed(sheetList, "sheet");
  const sheets = listed.map((sheet) => ({
    name: sheet.getAttribute("name") ?? "",
    relationshipId: attributeNamed(sheet, "id", RELATIONSHIP_NS),
  }));
  const dateMode =
    root === null
      ? null
      : (findNamed(root, "workbookPr")?.getAttribute("date1904") ?? null);
  return {
    sheets,
    sheetCount,
    date1904: dateMode === "1" || dateMode === "true",
  };
}

/**
 * Resolve `target` against `base` the way jszip normalizes the names it
 * stores: empty and `.` segments drop out, and `..` pops the one before it.
 * jszip normalizes what it stores but not what `file()` looks up, so a target
 * spelled `./worksheets/sheet1.xml` would otherwise miss the part it names.
 */
function resolveZipPath(base: string, target: string): string {
  const segments: string[] = [];
  for (const segment of `${base}${target}`.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** The part a relationship target names, rooted at the zip. */
function resolveRelationshipTarget(base: string, target: string): string {
  // A part whose name holds a space is spelled `sheet%201.xml` here.
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Not valid percent-encoding, so the target is a literal name.
  }
  // A relative target is relative to the part that declares it.
  return decoded.startsWith("/")
    ? resolveZipPath("", decoded.slice(1))
    : resolveZipPath(base, decoded);
}

/** The relationship part a package opens with, which names its workbook. */
const PACKAGE_RELATIONSHIPS_PART = "_rels/.rels";

/** Last segment of the relationship type a package names its workbook by. */
const OFFICE_DOCUMENT_TYPE = "/officeDocument";

/** Where a package holds its workbook by convention. */
const DEFAULT_WORKBOOK_PART = "xl/workbook.xml";

/** The workbook part the package points at, rooted at the zip. */
function readPackageWorkbookPart(xml: string | null): string {
  if (xml === null) {
    return DEFAULT_WORKBOOK_PART;
  }
  const captured = captureElements(xml, [
    {
      localName: "Relationship",
      keep: (tag) => {
        const type = attributeInTag(tag, "Type");
        return type !== null && type.endsWith(OFFICE_DOCUMENT_TYPE);
      },
      limit: 1,
    },
  ]);
  if (captured.xml === null) {
    return DEFAULT_WORKBOOK_PART;
  }
  const root = parseXml(captured.xml, PACKAGE_RELATIONSHIPS_PART);
  for (const relationship of directChildrenNamed(root, "Relationship")) {
    const target = relationship.getAttribute("Target");
    if (target !== null) {
      return resolveRelationshipTarget("", target);
    }
  }
  return DEFAULT_WORKBOOK_PART;
}

/** The directory `path` sits in, up to and including its last `/`. */
function partDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/** The relationship part that belongs to the part at `path`. */
function relationshipsPartFor(path: string): string {
  const directory = partDirectory(path);
  return `${directory}_rels/${path.slice(directory.length)}.rels`;
}

/**
 * The parts a workbook holds beside its sheets, named by the last segment of
 * the relationship type pointing at each. Strict and transitional OOXML root
 * those types at namespaces of their own, so only the segment they share
 * identifies a part.
 */
const RELATED_PART_NAMES = ["sharedStrings", "styles"] as const;

type RelatedPart = (typeof RELATED_PART_NAMES)[number];

/** What a workbook's relationship part names, rooted at the zip. */
interface WorkbookRelationships {
  /** Relationship id to the part path it points at. */
  targets: Map<string, string>;
  /** The shared string part the workbook points at, or the conventional one. */
  sharedStrings: string;
  /** The styles part the workbook points at, or the conventional one. */
  styles: string;
}

/**
 * The parts a workbook's relationship part points at: the sheets `sheetIds`
 * names, and the parts it holds beside them. Targets are relative to `base`,
 * the directory the workbook itself sits in, and so are the parts it points at
 * by convention.
 */
function readWorkbookRelationships(
  xml: string | null,
  base: string,
  partPath: string,
  sheetIds: ReadonlySet<string>,
): WorkbookRelationships {
  const targets = new Map<string, string>();
  const related: Record<RelatedPart, string> = {
    sharedStrings: `${base}sharedStrings.xml`,
    styles: `${base}styles.xml`,
  };
  if (xml === null) {
    return { targets, ...related };
  }
  const captured = captureElements(xml, [
    {
      localName: "Relationship",
      keep: (tag) => {
        const id = attributeInTag(tag, "Id");
        if (id !== null && sheetIds.has(id)) {
          return true;
        }
        const type = attributeInTag(tag, "Type");
        return (
          type !== null &&
          RELATED_PART_NAMES.some((name) => type.endsWith(`/${name}`))
        );
      },
      limit: sheetIds.size + RELATED_PART_NAMES.length,
    },
  ]);
  if (captured.xml === null) {
    return { targets, ...related };
  }
  const root = parseXml(captured.xml, partPath);
  for (const relationship of directChildrenNamed(root, "Relationship")) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id === null || target === null) {
      continue;
    }
    const resolved = resolveRelationshipTarget(base, target);
    targets.set(id, resolved);
    const type = relationship.getAttribute("Type");
    if (type === null) {
      continue;
    }
    for (const name of RELATED_PART_NAMES) {
      if (type.endsWith(`/${name}`)) {
        related[name] = resolved;
      }
    }
  }
  return { targets, ...related };
}

/**
 * How many cell formats a style table is read for, which is the limit Excel
 * itself puts on a workbook. A part can declare far more inside the character
 * cap, and a cell whose style sits past this one renders as a plain number.
 */
export const MAX_CELL_FORMATS = 64_000;

/** Per `cellXfs` index, what cells carrying that style render as. */
function readStyleFormats(xml: string | null, partPath: string): StyleFormat[] {
  if (xml === null) {
    return [];
  }
  const captured = captureElements(xml, [
    { localName: "numFmt", container: "numFmts", limit: MAX_CELL_FORMATS },
    { localName: "xf", container: "cellXfs", limit: MAX_CELL_FORMATS },
  ]);
  if (captured.xml === null) {
    return [];
  }
  const root = parseXml(captured.xml, partPath);
  const customCodes = new Map<number, string>();
  // Scoped to the `numFmts` block because a `dxf` carries `numFmt` entries of
  // its own in the same id range, which would otherwise win on document order.
  const numFmts = findNamed(root, "numFmts");
  if (numFmts !== undefined) {
    for (const format of directChildrenNamed(numFmts, "numFmt")) {
      const id = Number(format.getAttribute("numFmtId"));
      const code = format.getAttribute("formatCode");
      if (Number.isInteger(id) && code !== null) {
        customCodes.set(id, code);
      }
    }
  }
  const cellXfs = findNamed(root, "cellXfs");
  if (cellXfs === undefined) {
    return [];
  }
  return directChildrenNamed(cellXfs, "xf").map((xf) => {
    const id = Number(xf.getAttribute("numFmtId") ?? "0");
    const code = customCodes.get(id);
    if (code !== undefined) {
      return formatCodeStyle(code);
    }
    // A built-in id spells one rendering, which every value takes.
    return [{ condition: null, kind: builtInFormatKind(id) }];
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The hour field a clock reading spells: two digits on a 24-hour clock, and
 * the unpadded 1 to 12 a meridiem format counts in, where midnight and noon
 * are both 12.
 */
function clockHour(hours: number, meridiem: Meridiem | null): string {
  if (meridiem === null) {
    return pad(hours);
  }
  return String(hours % 12 === 0 ? 12 : hours % 12);
}

/** What closes a 12-hour reading, which `A/P` spells as its one letter. */
function meridiemSuffix(hours: number, meridiem: Meridiem): string {
  const half = hours < 12 ? "A" : "P";
  return meridiem === "A/P" ? half : `${half}M`;
}

/**
 * Whether a serial sits inside the calendar Excel's date systems can spell.
 * A column of unix milliseconds that inherited a date style, or a negative
 * serial, is past every `Date` this could build and renders as its number.
 */
function isDateSerial(serial: number, date1904: boolean): boolean {
  return (
    serial >= 0 && serial <= (date1904 ? MAX_SERIAL_1904 : MAX_SERIAL_1900)
  );
}

/**
 * Render a serial the way its number format reads it: a calendar day, a clock
 * reading, or both. A date format spells the day alone however much of a day
 * the serial carries, and a clock reading runs to the second only for a format
 * that spells one, truncating the fields it has no room for. A 12-hour format
 * counts the hour from 1 to 12 and closes with its meridiem. The 1900 workbook
 * counts a 29 February 1900 that never existed, so serials below 60 sit one day
 * behind the real calendar, and serial 60 is that phantom day itself. Excel
 * shows it as 1900-02-29, so it is written out: no `Date` can hold it, and
 * computing it would collapse it onto serial 59.
 */
function formatSerial(
  serial: number,
  format: SerialFormat,
  date1904: boolean,
): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = !date1904 && serial < 60 ? serial + 1 : serial;
  const at = epoch + Math.round(days * MS_PER_DAY);
  const moment = new Date(at);
  const hours = moment.getUTCHours();
  const meridiem = format.kind === "date" ? null : format.meridiem;
  const clock = `${clockHour(hours, meridiem)}:${pad(moment.getUTCMinutes())}`;
  const fields =
    format.kind === "date" || !format.seconds
      ? clock
      : `${clock}:${pad(moment.getUTCSeconds())}`;
  const reading =
    meridiem === null ? fields : `${fields} ${meridiemSuffix(hours, meridiem)}`;
  if (format.kind === "time") {
    return reading;
  }
  const day =
    !date1904 && serial >= 60 && serial < 61
      ? "1900-02-29"
      : `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}`;
  if (format.kind === "datetime") {
    return `${day} ${reading}`;
  }
  return day;
}

const SECONDS_PER_DAY = 86_400;

/**
 * Render a serial as a duration running from `from` down to `to`. An elapsed
 * format keeps the whole span in its leading field, which is what `[h]:mm:ss`
 * spells as 48:00:00 where a clock reading would wrap to midnight, so the
 * fields are counted off the serial rather than off a `Date`.
 */
function formatElapsed(
  serial: number,
  from: ElapsedUnit,
  to: ElapsedUnit,
): string {
  const total = Math.round(serial * SECONDS_PER_DAY);
  const leading =
    from === "hours"
      ? Math.floor(total / 3600)
      : from === "minutes"
        ? Math.floor(total / 60)
        : total;
  const fields = [leading];
  if (from === "hours" && to !== "hours") {
    fields.push(Math.floor(total / 60) % 60);
  }
  if (to === "seconds" && from !== "seconds") {
    fields.push(total % 60);
  }
  return fields.map(pad).join(":");
}

/**
 * A cell is either finished text or an index into the shared string table,
 * which is read only as far as the sheet pointing into it reaches.
 */
type RawCell = string | number;

/** Text of the `<v>` child, or `null` when the cell holds no cached value. */
function cachedValue(cell: Element): string | null {
  const value = firstChildNamed(cell, "v");
  return value === undefined ? null : (value.textContent ?? "");
}

/**
 * Text of a shared or inline string: the item's own `<t>` children plus the
 * `<t>` inside each `<r>` run, in order. Anything else a string item carries
 * is skipped, which is what keeps the phonetic guide in an East Asian
 * workbook's `<rPh>` out of the text the cell shows.
 */
function joinTextRuns(element: Element | undefined): string {
  if (element === undefined) {
    return "";
  }
  let text = "";
  const children = element.children;
  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);
    if (child === null) {
      continue;
    }
    const name = localPart(child.localName);
    if (name === "t") {
      text += child.textContent ?? "";
    } else if (name === "r") {
      for (const run of directChildrenNamed(child, "t")) {
        text += run.textContent ?? "";
      }
    }
  }
  return text;
}

function readCell(
  cell: Element,
  styleFormats: StyleFormat[],
  date1904: boolean,
): RawCell {
  const type = cell.getAttribute("t");
  if (type === "s") {
    const raw = cachedValue(cell);
    if (raw === null || raw === "") {
      // A shared-string cell with no index points at nothing, which is blank
      // rather than the first string in the table.
      return "";
    }
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? index : "";
  }
  if (type === "inlineStr") {
    return joinTextRuns(firstChildNamed(cell, "is"));
  }

  const value = cachedValue(cell);
  const hasResult = value !== null && value !== "";
  if (!hasResult) {
    // openpyxl writes an unevaluated formula with no cached result, or with an
    // empty one, so an empty `<v>` means no result rather than zero or false.
    // This runs before the typed branches because the cell's declared type
    // says nothing about whether it was evaluated, and showing the formula
    // beats showing a blank where the user knows there is data. A shared
    // formula's followers carry no text of their own, so they fall through to
    // the typed reading rather than showing a bare `=`.
    const formula = firstChildNamed(cell, "f")?.textContent ?? "";
    if (formula !== "") {
      return `=${formula}`;
    }
  }
  if (type === "b") {
    return value === "1" ? "TRUE" : "FALSE";
  }
  if (type === "e" || type === "str" || type === "d") {
    return value ?? "";
  }
  if (!hasResult) {
    return "";
  }
  const asNumber = Number(value);
  if (Number.isNaN(asNumber)) {
    return value;
  }
  const style =
    styleFormats[Number(cell.getAttribute("s") ?? "0")] ?? PLAIN_STYLE;
  const format = selectFormatKind(style, asNumber);
  if (isDateSerial(asNumber, date1904)) {
    if (format.kind === "elapsed") {
      return formatElapsed(asNumber, format.from, format.to);
    }
    if (format.kind !== "none") {
      return formatSerial(asNumber, format, date1904);
    }
  }
  return String(asNumber);
}

/** Column index from a cell reference such as `AA7`, with `A` at 0. */
function columnIndexFromRef(ref: string | null): number | null {
  if (ref === null) {
    return null;
  }
  let index = 0;
  let letters = 0;
  for (const character of ref) {
    const code = character.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) {
      break;
    }
    index = index * 26 + (code - 64);
    letters += 1;
  }
  return letters === 0 ? null : index - 1;
}

interface SheetRows {
  rows: RawCell[][];
  /** True when the column cap or the row cap cut something out. */
  truncated: boolean;
  /** Every shared string index the kept cells point at. */
  sharedIndices: Set<number>;
}

function readSheetRows(
  root: Element,
  styleFormats: StyleFormat[],
  date1904: boolean,
): SheetRows {
  const rows: RawCell[][] = [];
  const sharedIndices = new Set<number>();
  let truncated = false;

  const sheetData = findNamed(root, "sheetData");
  if (sheetData === undefined) {
    return { rows, truncated, sharedIndices };
  }
  for (const row of directChildrenNamed(sheetData, "row")) {
    if (rows.length >= MAX_CSV_ROWS) {
      truncated = true;
      break;
    }
    // A worksheet omits rows that are entirely blank and records where the
    // next one sits, so the gap has to be refilled or every later row moves up.
    const position = Number(row.getAttribute("r"));
    if (Number.isInteger(position) && position > rows.length + 1) {
      const fillTo = Math.min(position - 1, MAX_CSV_ROWS);
      while (rows.length < fillTo) {
        rows.push([]);
      }
      if (rows.length >= MAX_CSV_ROWS) {
        truncated = true;
        break;
      }
    }
    const cells: RawCell[] = [];
    let column = -1;
    for (const cell of directChildrenNamed(row, "c")) {
      column = columnIndexFromRef(cell.getAttribute("r")) ?? column + 1;
      if (column >= MAX_SHEET_COLUMNS) {
        truncated = true;
        continue;
      }
      // Excel omits empty cells, so a jump in the reference leaves a gap.
      while (cells.length < column) {
        cells.push("");
      }
      const parsed = readCell(cell, styleFormats, date1904);
      if (typeof parsed === "number") {
        sharedIndices.add(parsed);
      }
      cells[column] = parsed;
    }
    rows.push(cells);
  }
  return { rows, truncated, sharedIndices };
}

/** The end cell of a range, as `A1:KN20`, `A1`, and `$A$1:$KN$20` spell one. */
const RANGE_END = /^\$?([A-Za-z]+)\$?([0-9]+)$/;

/**
 * The used range the sheet declares, which sits before its rows as
 * `<dimension ref="A1:KN20"/>`. A worksheet may leave the record out, spell a
 * single cell, or spell a range nothing can be read from, and any of those
 * reads as no extent rather than as a range to defend.
 */
function readSheetExtent(root: Element): SheetExtent | null {
  const declared = directChildrenNamed(root, "dimension").find(
    (element) => element.namespaceURI === root.namespaceURI,
  );
  if (declared === undefined) {
    return null;
  }
  const end = (declared.getAttribute("ref") ?? "").split(":")[1] ?? "";
  const match = RANGE_END.exec(end);
  const column = match === null ? null : columnIndexFromRef(match[1]!);
  const rows = Number(match?.[2] ?? "0");
  if (column === null || !Number.isSafeInteger(rows) || rows === 0) {
    return null;
  }
  return { rows, columns: column + 1 };
}

/** What one read of the shared string part took out of it. */
interface SparseStrings {
  /** A document holding the wanted items, or `null` when it holds none. */
  xml: string | null;
  /** The index of each item the document holds, in order. */
  indices: number[];
  /**
   * The first index the part cannot answer for, which is where it ran out or
   * where the character cap stopped the read, and `null` when the read had
   * everything it was after before either.
   */
  absentFrom: number | null;
}

/**
 * Stream the shared string part for the items `wanted` names, keeping each
 * one's own text and nothing else. A table holds every string a workbook
 * spells, so a sheet pointing at one entry near the end of a million would
 * otherwise cost a DOM of everything before it. An item runs to its own close,
 * and the read stops at the highest index it was after rather than at the end
 * of the part. Every `si` in the part counts, and a table spells its extension
 * list after its items, so an item of another origin there takes an index past
 * every string the table holds, which no cell of a workbook points at.
 */
function readSharedStringSpans(
  entry: JSZip.JSZipObject,
  wanted: ReadonlySet<number>,
  maxChars: number,
  batchChars: number,
): Promise<SparseStrings> {
  let highest = -1;
  for (const index of wanted) {
    highest = Math.max(highest, index);
  }
  const spans: string[] = [];
  const indices: number[] = [];
  let searchFrom = 0;
  let count = 0;
  let head: string | null = null;
  let closing = "";
  let openAt = -1;
  let openIndex = -1;

  const taken = (absentFrom: number | null): SparseStrings => ({
    xml:
      head === null || closing === "" || spans.length === 0
        ? null
        : `${head}${spans.join("")}${closing}`,
    indices,
    absentFrom,
  });

  const read: StreamedRead<SparseStrings> = {
    onChunk: (buffer, settle) => {
      for (;;) {
        const at = buffer.indexOf("<", searchFrom);
        if (at === -1) {
          searchFrom = buffer.length;
          break;
        }
        const construct = matchNonTag(buffer, at);
        if (construct.kind === "pending") {
          searchFrom = at;
          break;
        }
        if (construct.kind === "skip") {
          searchFrom = construct.to;
          continue;
        }
        const match = matchStartTag(buffer, at, "si");
        if (match.kind === "pending") {
          searchFrom = at;
          break;
        }
        searchFrom = at + 1;
        if (match.kind === "other") {
          continue;
        }
        if (head === null) {
          // Everything before the first item, which carries the declaration
          // and the table's own start tag with its namespaces.
          head = buffer.slice(0, at);
          const root = firstStartTag(head);
          closing = root === null ? "" : `</${root.name}>`;
        }
        if (openAt >= 0) {
          spans.push(buffer.slice(openAt, elementEndsAt(buffer, openAt, "si")));
          indices.push(openIndex);
          openAt = -1;
        }
        if (wanted.has(count)) {
          openAt = at;
          openIndex = count;
        }
        count += 1;
        if (openAt < 0 && count > highest) {
          settle.resolve(taken(null));
          return;
        }
      }
      if (buffer.length > maxChars) {
        // The items past the cap are out of reach, and the item open at it is
        // half read, so the cells pointing at them read as blank.
        settle.resolve(taken(openAt >= 0 ? count - 1 : count));
      }
    },
    onEnd: (buffer) => {
      if (openAt >= 0) {
        spans.push(buffer.slice(openAt, elementEndsAt(buffer, openAt, "si")));
        indices.push(openIndex);
      }
      return taken(count);
    },
  };
  return streamPart(entry, read, batchChars);
}

/** Drop the entries added longest ago until `map` holds `limit` of them. */
function evictOldest<K, V>(map: Map<K, V>, limit: number): void {
  for (const key of map.keys()) {
    if (map.size <= limit) {
      return;
    }
    map.delete(key);
  }
}

/** The strings a sheet points at, by the index each one carries. */
type SharedStringReader = (
  wanted: ReadonlySet<number>,
) => Promise<ReadonlyMap<number, string>>;

/**
 * Reader over the one shared string table the whole workbook points into. It
 * keeps every string it has found and the index the part runs out at, so a
 * sheet asking only for strings already in hand, or only for indices the part
 * cannot answer for, reads nothing. Reads are chained because two sheets
 * resolving at once would otherwise inflate the same part twice. The chain is
 * this reader's own, so a shared string read nested inside a sheet's turn on
 * the sheet queue never waits on that queue.
 */
function createSharedStringReader(
  zip: JSZip,
  partPath: string,
  limits: PartLimits,
): SharedStringReader {
  const found = new Map<number, string>();
  let absentFrom = Number.POSITIVE_INFINITY;
  let queue: Promise<void> = Promise.resolve();
  return (wanted) => {
    const read = queue.then(async () => {
      const missing = new Set<number>();
      for (const index of wanted) {
        if (!found.has(index) && index < absentFrom) {
          missing.add(index);
        }
      }
      const entry = missing.size === 0 ? null : zip.file(partPath);
      if (entry === null) {
        absentFrom = missing.size === 0 ? absentFrom : 0;
      } else {
        const taken = await readSharedStringSpans(
          entry,
          missing,
          limits.maxPartChars,
          limits.streamBatchChars,
        );
        if (taken.xml !== null) {
          const table = findNamed(parseXml(taken.xml, partPath), "sst");
          const items =
            table === undefined ? [] : directChildrenNamed(table, "si");
          items.forEach((item, position) => {
            const index = taken.indices[position];
            if (index !== undefined) {
              found.set(index, joinTextRuns(item));
            }
          });
        }
        if (taken.absentFrom !== null) {
          absentFrom = Math.min(absentFrom, taken.absentFrom);
        }
      }
      const answer = new Map<number, string>();
      for (const index of wanted) {
        const text = found.get(index);
        if (text !== undefined) {
          answer.set(index, text);
        }
      }
      // After the answer, so a sheet reading more strings than the cache
      // holds still gets every one of them.
      evictOldest(found, limits.maxCachedStrings);
      return answer;
    });
    // A rejected read must not wedge the sheet that asks next.
    queue = read.then(
      () => undefined,
      () => undefined,
    );
    return read;
  };
}

/** The sizes one workbook is read under, which tests lower. */
interface PartLimits {
  maxPartChars: number;
  streamBatchChars: number;
  maxCachedStrings: number;
}

/** What every sheet of one workbook shares while it reads its own part. */
interface WorkbookContext {
  zip: JSZip;
  styleFormats: StyleFormat[];
  date1904: boolean;
  limits: PartLimits;
  sharedStrings: SharedStringReader;
}

/**
 * The same sheet XML with the cells past the column cap dropped from every
 * row, so the DOM built over it holds at most {@link MAX_SHEET_COLUMNS} cells a
 * row. Rows are bounded by the marker the part is read with, while a sheet
 * whose rows run thousands of columns wide inflates well inside the part cap
 * and every one of those cells would otherwise become a node the preview has
 * no room for. Cell text escapes `<` as `&lt;`, so the only markup-like text
 * in a sheet sits inside the constructs {@link skipNonTag} steps over.
 */
function dropCellsPastCap(xml: string): { xml: string; dropped: boolean } {
  const kept: string[] = [];
  let copiedTo = 0;
  let cells = 0;
  let at = xml.indexOf("<");
  while (at >= 0) {
    const pastConstruct = skipNonTag(xml, at);
    if (pastConstruct >= 0) {
      at = xml.indexOf("<", pastConstruct);
      continue;
    }
    if (matchStartTag(xml, at, "row").kind === "match") {
      cells = 0;
    } else if (matchStartTag(xml, at, "c").kind === "match") {
      cells += 1;
      if (cells > MAX_SHEET_COLUMNS) {
        const rowEnd = findEndTag(xml, at, "row");
        kept.push(xml.slice(copiedTo, at));
        copiedTo = rowEnd;
        at = rowEnd;
      }
    }
    at = xml.indexOf("<", at + 1);
  }
  if (kept.length === 0) {
    return { xml, dropped: false };
  }
  kept.push(xml.slice(copiedTo));
  return { xml: kept.join(""), dropped: true };
}

/** What a sheet pointing at no shared string reads its cells from. */
const NO_SHARED_STRINGS: ReadonlyMap<number, string> = new Map();

async function readSheetGrid(
  context: WorkbookContext,
  name: string,
  target: string | undefined,
): Promise<SheetGrid> {
  const entry = target === undefined ? null : context.zip.file(target);
  if (entry === null) {
    throw new Error(`Sheet "${name}" points at no worksheet part`);
  }
  const part = await readMarkedPart(
    entry,
    {
      localName: "row",
      limit: MAX_CSV_ROWS,
      budget: { localName: "c", limit: MAX_SHEET_CELLS },
    },
    ["sheetData", "worksheet"],
    context.limits.maxPartChars,
    context.limits.streamBatchChars,
  );
  const trimmed = dropCellsPastCap(closeBoundedPart(part));
  const root = parseXml(trimmed.xml, entry.name);
  const read = readSheetRows(root, context.styleFormats, context.date1904);
  const strings =
    read.sharedIndices.size === 0
      ? NO_SHARED_STRINGS
      : await context.sharedStrings(read.sharedIndices);
  // A shared string past a cut table reads as blank, which the sheet that
  // pointed at it has to own up to.
  let lostSharedString = false;
  const records = read.rows.map((row) =>
    row.map((cell) => {
      if (typeof cell !== "number") {
        return cell;
      }
      const text = strings.get(cell);
      if (text === undefined) {
        lostSharedString = true;
        return "";
      }
      return text;
    }),
  );
  return {
    ...shapeRecords(
      records,
      records.reduce((max, row) => Math.max(max, row.length), 0),
      part.truncated || trimmed.dropped || read.truncated || lostSharedString,
    ),
    extent: readSheetExtent(root),
  };
}

/**
 * How many sheet grids one workbook holds. The panel shows one sheet at a
 * time, so a few recent grids cover tabbing back and forth while a grid of up
 * to {@link MAX_SHEET_CELLS} cells per visited sheet never piles up.
 */
export const MAX_CACHED_SHEETS = 3;

/**
 * How many sheets a workbook builds a reader for, which is what the switcher
 * shows. Workbook metadata is compact enough that a generated file can declare
 * thousands of sheets inside the part limits, and a reader apiece costs the
 * browser before a single sheet is read, so the sheets past this one are
 * counted and left unbuilt.
 */
export const MAX_WORKBOOK_SHEETS = 100;

/** A sheet's grid promise, whether it has settled, and its place in line. */
interface CachedGrid {
  grid: Promise<SheetGrid>;
  settled: boolean;
  prioritize: () => void;
}

/**
 * A queued read's grid, and the request to serve it next among those waiting.
 */
interface QueuedGrid {
  grid: Promise<SheetGrid>;
  /** Moves this read to the next turn, or does nothing once it has one. */
  prioritize: () => void;
}

/** Runs one workbook's sheet reads, one at a time and newest request first. */
type ReadQueue = (read: () => Promise<SheetGrid>) => QueuedGrid;

/** A read waiting its turn, holding the promise its caller already has. */
interface QueuedRead {
  read: () => Promise<SheetGrid>;
  resolve: (grid: SheetGrid) => void;
  reject: (reason: unknown) => void;
}

/**
 * Serializer for the sheet reads of one workbook. A panel that unmounts does
 * not cancel the read it started, so clicking through the tabs of a 24-sheet
 * workbook would otherwise inflate and parse 24 capped grids at once. Running
 * one read at a time costs a workbook one grid in flight however fast the
 * tabs are clicked. The newest request runs next because that is the tab
 * being looked at, which waits on nothing but the read already running. A
 * read asked for again while it waits takes that turn instead, so a tab
 * returned to is served before the ones abandoned on the way to it.
 */
function createReadQueue(): ReadQueue {
  const waiting: QueuedRead[] = [];
  let running = false;
  const runNext = (): void => {
    const next = waiting.pop();
    if (next === undefined) {
      running = false;
      return;
    }
    running = true;
    void (async () => {
      try {
        next.resolve(await next.read());
      } catch (reason) {
        next.reject(reason);
      }
      runNext();
    })();
  };
  return (read) => {
    let queued: QueuedRead | null = null;
    const grid = new Promise<SheetGrid>((resolve, reject) => {
      queued = { read, resolve, reject };
      waiting.push(queued);
      if (!running) {
        runNext();
      }
    });
    return {
      grid,
      prioritize: () => {
        if (queued === null) {
          return;
        }
        const at = waiting.indexOf(queued);
        if (at < 0) {
          return;
        }
        waiting.splice(at, 1);
        waiting.push(queued);
      },
    };
  };
}

/** Serves one workbook's sheet grid by index, reading it on a miss. */
type GridCache = (index: number, read: () => QueuedGrid) => Promise<SheetGrid>;

/**
 * Cache of the {@link MAX_CACHED_SHEETS} most recently read grids of one
 * workbook, keyed by sheet index and held in least recently read order. Only a
 * settled entry is evicted, so every caller of a read still in flight shares
 * the one inflation of that part. An entry whose read is queued or running
 * holds no grid yet, so one sitting past the cap costs nothing: memory is
 * bounded by the single read the queue lets run plus the grids kept here.
 * A hit on an entry whose read is still queued moves that read to the next
 * turn, since the sheet asking again is the one on screen.
 */
function createGridCache(): GridCache {
  const cached = new Map<number, CachedGrid>();
  const evict = (): void => {
    for (const [index, entry] of cached) {
      if (cached.size <= MAX_CACHED_SHEETS) {
        return;
      }
      if (entry.settled) {
        cached.delete(index);
      }
    }
  };
  return (index, read) => {
    const hit = cached.get(index);
    if (hit !== undefined) {
      // Reinsert so the freshest read sits last in eviction order.
      cached.delete(index);
      cached.set(index, hit);
      hit.prioritize();
      return hit.grid;
    }
    const queued = read();
    const entry: CachedGrid = {
      grid: queued.grid,
      settled: false,
      prioritize: queued.prioritize,
    };
    cached.set(index, entry);
    const settle = (): void => {
      entry.settled = true;
      evict();
    };
    entry.grid.then(settle, settle);
    evict();
    return entry.grid;
  };
}

/** A sheet's `read`, served from the grids its workbook is holding. */
function createSheetReader(
  cache: GridCache,
  queue: ReadQueue,
  index: number,
  context: WorkbookContext,
  name: string,
  target: string | undefined,
): () => Promise<SheetGrid> {
  return () =>
    cache(index, () => queue(() => readSheetGrid(context, name, target)));
}

export interface ParseWorkbookOptions {
  /** Character cap per inflated part, which tests lower to a readable size. */
  maxPartChars?: number;
  /** Inflated text per streamed batch, which tests lower to a chunk. */
  streamBatchChars?: number;
  /** Shared strings held between sheet reads, which tests lower to a few. */
  maxCachedStrings?: number;
  /** Entries the container may hold, which tests lower to a handful. */
  maxZipEntries?: number;
}

/**
 * Read a workbook container's metadata into one lazily read sheet per visible
 * sheet. The package relationship part names the workbook, which the sheets,
 * the shared strings, and the styles are all read relative to. Rejects when
 * the blob is not a zip or holds no workbook part, which the preview shows as
 * an unreadable file. A sheet whose own part is missing or malformed rejects
 * from its `read`, leaving the rest readable.
 */
export async function parseWorkbook(
  blob: Blob,
  options: ParseWorkbookOptions = {},
): Promise<ParsedWorkbook> {
  const maxPartChars = options.maxPartChars ?? MAX_PART_CHARS;
  const limits: PartLimits = {
    maxPartChars,
    // A batch never outruns the character cap, so a read that has to stop at
    // the cap stops within a batch of it.
    streamBatchChars: Math.min(
      options.streamBatchChars ?? STREAM_BATCH_CHARS,
      maxPartChars,
    ),
    maxCachedStrings: options.maxCachedStrings ?? MAX_CACHED_STRINGS,
  };
  // An ArrayBuffer rather than the Blob, so one call covers the browser and
  // the test runner.
  const bytes = await blob.arrayBuffer();
  const maxZipEntries = options.maxZipEntries ?? MAX_ZIP_ENTRIES;
  // Before the reader is handed the bytes, since it holds every entry it
  // finds whether or not a workbook is among them.
  const entries = zipEntryCount(bytes, maxZipEntries);
  if (entries !== null && entries > maxZipEntries) {
    throw new Error(
      `Not a workbook: it holds more than ${maxZipEntries} zip entries`,
    );
  }
  const zip = await JSZip.loadAsync(bytes);
  const workbookPart = readPackageWorkbookPart(
    await readPart(
      zip,
      PACKAGE_RELATIONSHIPS_PART,
      limits.maxPartChars,
      limits.streamBatchChars,
    ),
  );
  const workbookXml = await readPart(
    zip,
    workbookPart,
    limits.maxPartChars,
    limits.streamBatchChars,
  );
  if (workbookXml === null) {
    throw new Error(`Not a workbook: ${workbookPart} is missing`);
  }

  const { sheets, sheetCount, date1904 } = readWorkbookStructure(
    workbookXml,
    workbookPart,
  );
  const relationshipsPart = relationshipsPartFor(workbookPart);
  const relationships = readWorkbookRelationships(
    await readPart(
      zip,
      relationshipsPart,
      limits.maxPartChars,
      limits.streamBatchChars,
    ),
    partDirectory(workbookPart),
    relationshipsPart,
    new Set(
      sheets
        .map((sheet) => sheet.relationshipId)
        .filter((id): id is string => id !== null),
    ),
  );
  const context: WorkbookContext = {
    zip,
    styleFormats: readStyleFormats(
      await readPart(
        zip,
        relationships.styles,
        limits.maxPartChars,
        limits.streamBatchChars,
      ),
      relationships.styles,
    ),
    date1904,
    limits,
    sharedStrings: createSharedStringReader(
      zip,
      relationships.sharedStrings,
      limits,
    ),
  };

  const grids = createGridCache();
  const reads = createReadQueue();
  return {
    sheetCount,
    sheets: sheets.map((sheet, index) => ({
      name: sheet.name,
      read: createSheetReader(
        grids,
        reads,
        index,
        context,
        sheet.name,
        sheet.relationshipId === null
          ? undefined
          : relationships.targets.get(sheet.relationshipId),
      ),
    })),
  };
}
