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
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  shapeRecords,
  type ParsedCsv,
} from "@/domains/chat/components/local-file/preview/csv";

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
  read(): Promise<ParsedCsv>;
}

export interface ParsedWorkbook {
  sheets: WorkbookSheet[];
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
 * What a cell's number format renders its value as. An `elapsed` format keeps
 * the whole span it is handed instead of wrapping at midnight, so it carries
 * the units its fields run between: `[h]:mm:ss` runs from hours to seconds,
 * `[mm]:ss` from minutes to seconds.
 */
type NumberFormatKind =
  | { kind: "none" | "date" | "time" | "datetime" }
  | { kind: "elapsed"; from: ElapsedUnit; to: ElapsedUnit };

/** What a cell renders as when nothing styles it as a date or a duration. */
const PLAIN_NUMBER: NumberFormatKind = { kind: "none" };

/**
 * What a built-in `numFmtId` renders. The date ids spell a calendar day, the
 * time ids a clock reading, 22 is the one built-in that spells both, and 46
 * (`[h]:mm:ss`) is the one that counts elapsed hours. Ids 45 (`mm:ss`) and 47
 * (`mmss.0`) read the minutes and seconds of a time of day, so they stay
 * clock readings, and so do the East Asian ids 32 (`h"時"mm"分"`) and 33
 * (`h"時"mm"分"ss"秒"`), which sit between the date ids 27 to 31 and 34 to
 * 36.
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
    return { kind: "time" };
  }
  return id === 22 ? { kind: "datetime" } : PLAIN_NUMBER;
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
 * The section of `code` that applies to the values this reader renders. A code
 * holds one section per sign, in the order positive, negative, zero, text, and
 * a serial read as a date, a time, or elapsed time is positive. A quoted
 * literal, a bracket, and a backslash escape can each hold a `;` that
 * separates nothing.
 */
function firstFormatSection(code: string): string {
  let quoted = false;
  let bracketed = false;
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
      return code.slice(0, index);
    }
    index += 1;
  }
  return code;
}

/**
 * What a custom format code renders, read from the section that applies.
 * Quoted literals, bracketed sections, the meridiem tokens, and backslash
 * escapes can each hold a letter that spells no placeholder, so they come out
 * before the placeholders are read: a meridiem leaves a clock reading behind
 * it, a colour or locale bracket leaves nothing, and a bracket spelling
 * nothing but `h`, `m`, or `s` makes the code elapsed time, counted from its
 * largest bracketed unit down to the smallest unit the code spells.
 */
function formatCodeKind(code: string): NumberFormatKind {
  const bracketed = new Set<ElapsedUnit>();
  const placeholders = firstFormatSection(code)
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
    .replace(/\\./g, "")
    .toLowerCase();
  const tokens = placeholders.replace(MERIDIEM, "");
  const hasMeridiem = tokens.length !== placeholders.length;
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
  let hasDate = /[yd]/.test(tokens);
  let hasTime = hasMeridiem || /[hs]/.test(tokens);
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
  if (hasDate) {
    return hasTime ? { kind: "datetime" } : { kind: "date" };
  }
  return hasTime ? { kind: "time" } : PLAIN_NUMBER;
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

/** A character XML allows inside an element name after its first. */
function isNameCharacter(character: string): boolean {
  return /[\w.-]/.test(character);
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

/**
 * Where the construct opened by the `<` at `at` ends, or -1 when that `<`
 * opens an ordinary tag. A scan over markup steps past one of these whole,
 * since the `<c>` an inline string holds inside CDATA opens no cell. An
 * unterminated construct runs to the end of the buffer.
 */
function skipNonTag(buffer: string, at: number): number {
  for (const { opens, closes } of NON_TAG_CONSTRUCTS) {
    if (buffer.startsWith(opens, at)) {
      const ends = buffer.indexOf(closes, at + opens.length);
      return ends < 0 ? buffer.length : ends + closes.length;
    }
  }
  return -1;
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
 * Inflate `entry` as a stream, handing each chunk to `read`. Settling from a
 * chunk abandons the rest of the stream, which is what lets a caller stop at
 * a cap instead of decompressing a part whole.
 */
function streamPart<T>(
  entry: JSZip.JSZipObject,
  read: StreamedRead<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const stream = (entry as StreamingEntry).internalStream("string");
    let buffer = "";
    let settled = false;
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
      buffer += chunk;
      read.onChunk(buffer, settle);
    });
    stream.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    stream.on("end", () => {
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
): Promise<string> {
  return streamPart(entry, {
    onChunk: (buffer, settle) => {
      if (buffer.length > maxChars) {
        settle.reject(new Error(`${entry.name} is too large to read`));
      }
    },
    onEnd: (buffer) => buffer,
  });
}

/**
 * Inflate `entry` only until `marker` has been seen past its limit or the text
 * passes `maxChars`, then cut it there and abandon the rest of the stream.
 * Either cut lands on the `<` of a marker, so the text ends on a complete
 * element and only `ancestors`, innermost first, are left open around it. This
 * is what keeps a sheet with a million rows from being decompressed whole for
 * a preview that shows five thousand. A cap reached before a second marker
 * would leave nothing complete behind, so the read rejects rather than
 * resolving a part that reads as empty.
 */
function readMarkedPart(
  entry: JSZip.JSZipObject,
  marker: PartMarker,
  ancestors: string[],
  maxChars: number,
): Promise<BoundedPart> {
  let searchFrom = 0;
  let seen = 0;
  let lastMarkerAt = -1;
  let lastMarkerPrefix = "";
  // Every ancestor opens before the first marker, so the scan has each one's
  // own spelling in hand by the time a cut needs to close it. The marker's
  // prefix is the fallback for an ancestor the scan never reached.
  const unseen = [...ancestors];
  const openedAs = new Map<string, string>();
  const stillOpen = (): string[] =>
    ancestors.map((name) => openedAs.get(name) ?? `${lastMarkerPrefix}${name}`);

  return streamPart(entry, {
    onChunk: (buffer, settle) => {
      for (;;) {
        const at = buffer.indexOf("<", searchFrom);
        if (at === -1) {
          searchFrom = buffer.length;
          break;
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
  });
}

/** A metadata part read whole, or `null` when the workbook leaves it out. */
async function readPart(
  zip: JSZip,
  path: string,
  maxChars: number,
): Promise<string | null> {
  const entry = zip.file(path);
  return entry === null ? null : readWholePart(entry, maxChars);
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
  hidden: boolean;
}

interface WorkbookStructure {
  sheets: SheetRef[];
  date1904: boolean;
}

function readWorkbookStructure(xml: string): WorkbookStructure {
  const root = parseXml(xml, "xl/workbook.xml");
  const dateMode = findNamed(root, "workbookPr")?.getAttribute("date1904");
  const sheetList = findNamed(root, "sheets");
  const listed =
    sheetList === undefined ? [] : directChildrenNamed(sheetList, "sheet");
  const sheets = listed.map((sheet) => {
    const state = sheet.getAttribute("state");
    return {
      name: sheet.getAttribute("name") ?? "",
      relationshipId: attributeNamed(sheet, "id", RELATIONSHIP_NS),
      hidden: state === "hidden" || state === "veryHidden",
    };
  });
  return { sheets, date1904: dateMode === "1" || dateMode === "true" };
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

/**
 * The parts a workbook holds beside its sheets, named by the last segment of
 * the relationship type pointing at each. Strict and transitional OOXML root
 * those types at namespaces of their own, so only the segment they share
 * identifies a part.
 */
const RELATED_PART_NAMES = ["sharedStrings", "styles"] as const;

type RelatedPart = (typeof RELATED_PART_NAMES)[number];

/** Where each of those parts sits by convention. */
const DEFAULT_RELATED_PARTS: Record<RelatedPart, string> = {
  sharedStrings: "xl/sharedStrings.xml",
  styles: "xl/styles.xml",
};

/** What a workbook's relationship part names, rooted at the zip. */
interface WorkbookRelationships {
  /** Relationship id to the part path it points at. */
  targets: Map<string, string>;
  /** The shared string part the workbook points at, or the conventional one. */
  sharedStrings: string;
  /** The styles part the workbook points at, or the conventional one. */
  styles: string;
}

/** The parts a workbook's relationship part points at. */
function readWorkbookRelationships(xml: string | null): WorkbookRelationships {
  const targets = new Map<string, string>();
  const related = { ...DEFAULT_RELATED_PARTS };
  if (xml === null) {
    return { targets, ...related };
  }
  const root = parseXml(xml, "xl/_rels/workbook.xml.rels");
  for (const relationship of directChildrenNamed(root, "Relationship")) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id === null || target === null) {
      continue;
    }
    // A part whose name holds a space is spelled `sheet%201.xml` here.
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // Not valid percent-encoding, so the target is a literal name.
    }
    // A relative target is relative to the part that declares it.
    const resolved = decoded.startsWith("/")
      ? resolveZipPath("", decoded.slice(1))
      : resolveZipPath("xl/", decoded);
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

/** Per `cellXfs` index, what cells carrying that style render as. */
function readNumberFormatKinds(
  xml: string | null,
  partPath: string,
): NumberFormatKind[] {
  if (xml === null) {
    return [];
  }
  const root = parseXml(xml, partPath);
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
    return code === undefined ? builtInFormatKind(id) : formatCodeKind(code);
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
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
 * reading, or both. The 1900 workbook counts a 29 February 1900 that never
 * existed, so serials below 60 sit one day behind the real calendar, and
 * serial 60 is that phantom day itself. Excel shows it as 1900-02-29, so it is
 * written out: no `Date` can hold it, and computing it would collapse it onto
 * serial 59.
 */
function formatSerial(
  serial: number,
  kind: "date" | "time" | "datetime",
  date1904: boolean,
): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = !date1904 && serial < 60 ? serial + 1 : serial;
  const at = epoch + Math.round(days * MS_PER_DAY);
  const moment = new Date(at);
  const clock = `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}`;
  const seconds = moment.getUTCSeconds();
  if (kind === "time") {
    return seconds === 0 ? clock : `${clock}:${pad(seconds)}`;
  }
  const day =
    !date1904 && serial >= 60 && serial < 61
      ? "1900-02-29"
      : `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}`;
  if (kind === "datetime") {
    return seconds === 0
      ? `${day} ${clock}`
      : `${day} ${clock}:${pad(seconds)}`;
  }
  return at % MS_PER_DAY === 0 ? day : `${day} ${clock}`;
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
  formatKinds: NumberFormatKind[],
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
  const format =
    formatKinds[Number(cell.getAttribute("s") ?? "0")] ?? PLAIN_NUMBER;
  if (isDateSerial(asNumber, date1904)) {
    if (format.kind === "elapsed") {
      return formatElapsed(asNumber, format.from, format.to);
    }
    if (format.kind !== "none") {
      return formatSerial(asNumber, format.kind, date1904);
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
  /** Highest shared string index referenced, or -1 when none were. */
  highestSharedIndex: number;
}

function readSheetRows(
  root: Element,
  formatKinds: NumberFormatKind[],
  date1904: boolean,
): SheetRows {
  const rows: RawCell[][] = [];
  let truncated = false;
  let highestSharedIndex = -1;

  const sheetData = findNamed(root, "sheetData");
  if (sheetData === undefined) {
    return { rows, truncated, highestSharedIndex };
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
      if (column >= MAX_CSV_COLUMNS) {
        truncated = true;
        continue;
      }
      // Excel omits empty cells, so a jump in the reference leaves a gap.
      while (cells.length < column) {
        cells.push("");
      }
      const parsed = readCell(cell, formatKinds, date1904);
      if (typeof parsed === "number") {
        highestSharedIndex = Math.max(highestSharedIndex, parsed);
      }
      cells[column] = parsed;
    }
    rows.push(cells);
  }
  return { rows, truncated, highestSharedIndex };
}

interface SharedStringTable {
  strings: string[];
  /** Highest index this read was asked to cover. */
  readUpTo: number;
  /** True when the read took the whole part, so no later read can add to it. */
  exhausted: boolean;
}

/** The shared string table, read only as far as a sheet reaches into it. */
async function readSharedStringTable(
  zip: JSZip,
  partPath: string,
  highestIndex: number,
  maxPartChars: number,
): Promise<SharedStringTable> {
  const entry = zip.file(partPath);
  if (entry === null) {
    return { strings: [], readUpTo: highestIndex, exhausted: true };
  }
  const part = await readMarkedPart(
    entry,
    { localName: "si", limit: highestIndex + 1 },
    ["sst"],
    maxPartChars,
  );
  const root = parseXml(closeBoundedPart(part), partPath);
  const table = findNamed(root, "sst");
  return {
    strings:
      table === undefined
        ? []
        : directChildrenNamed(table, "si").map((item) => joinTextRuns(item)),
    readUpTo: highestIndex,
    exhausted: !part.truncated,
  };
}

type SharedStringReader = (highestIndex: number) => Promise<string[]>;

/**
 * Reader over the one shared string table the whole workbook points into. It
 * keeps what it has read, so a sheet reaching no further than an earlier one
 * costs nothing, and a sheet reaching further re-reads the part to its own
 * maximum. Reads are chained because two sheets resolving at once would
 * otherwise inflate the same part twice. The chain is this reader's own, so a
 * shared string read nested inside a sheet's turn on the sheet queue never
 * waits on that queue.
 */
function createSharedStringReader(
  zip: JSZip,
  partPath: string,
  maxPartChars: number,
): SharedStringReader {
  let table: SharedStringTable | null = null;
  let queue: Promise<void> = Promise.resolve();
  return (highestIndex) => {
    const read = queue.then(async () => {
      if (
        table === null ||
        (!table.exhausted && table.readUpTo < highestIndex)
      ) {
        table = await readSharedStringTable(
          zip,
          partPath,
          highestIndex,
          maxPartChars,
        );
      }
      return table.strings;
    });
    // A rejected read must not wedge the sheet that asks next.
    queue = read.then(
      () => undefined,
      () => undefined,
    );
    return read;
  };
}

/** What every sheet of one workbook shares while it reads its own part. */
interface WorkbookContext {
  zip: JSZip;
  formatKinds: NumberFormatKind[];
  date1904: boolean;
  maxPartChars: number;
  sharedStrings: SharedStringReader;
}

/** Where the row holding the `<` at `at` closes, or the end of `xml`. */
function findRowEnd(xml: string, at: number): number {
  let scan = xml.indexOf("<", at);
  while (scan >= 0) {
    const pastConstruct = skipNonTag(xml, scan);
    if (pastConstruct >= 0) {
      scan = xml.indexOf("<", pastConstruct);
      continue;
    }
    if (matchEndTag(xml, scan, "row")) {
      return scan;
    }
    scan = xml.indexOf("<", scan + 1);
  }
  return xml.length;
}

/**
 * The same sheet XML with the cells past the column cap dropped from every
 * row, so the DOM built over it holds at most {@link MAX_CSV_COLUMNS} cells a
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
      if (cells > MAX_CSV_COLUMNS) {
        const rowEnd = findRowEnd(xml, at);
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

async function readSheetGrid(
  context: WorkbookContext,
  name: string,
  target: string | undefined,
): Promise<ParsedCsv> {
  const entry = target === undefined ? null : context.zip.file(target);
  if (entry === null) {
    throw new Error(`Sheet "${name}" points at no worksheet part`);
  }
  const part = await readMarkedPart(
    entry,
    { localName: "row", limit: MAX_CSV_ROWS },
    ["sheetData", "worksheet"],
    context.maxPartChars,
  );
  const trimmed = dropCellsPastCap(closeBoundedPart(part));
  const read = readSheetRows(
    parseXml(trimmed.xml, entry.name),
    context.formatKinds,
    context.date1904,
  );
  const strings =
    read.highestSharedIndex < 0
      ? []
      : await context.sharedStrings(read.highestSharedIndex);
  // A shared string past a cut table reads as blank, which the sheet that
  // pointed at it has to own up to.
  let lostSharedString = false;
  const records = read.rows.map((row) =>
    row.map((cell) => {
      if (typeof cell !== "number") {
        return cell;
      }
      const text = strings[cell];
      if (text === undefined) {
        lostSharedString = true;
        return "";
      }
      return text;
    }),
  );
  return shapeRecords(
    records,
    records.reduce((max, row) => Math.max(max, row.length), 0),
    part.truncated || trimmed.dropped || read.truncated || lostSharedString,
  );
}

/**
 * How many sheet grids one workbook holds. The panel shows one sheet at a
 * time, so a few recent grids cover tabbing back and forth while a grid of up
 * to 5000 by 200 cells per visited sheet never piles up.
 */
export const MAX_CACHED_SHEETS = 3;

/** A sheet's grid promise, whether it has settled, and its place in line. */
interface CachedGrid {
  grid: Promise<ParsedCsv>;
  settled: boolean;
  prioritize: () => void;
}

/**
 * A queued read's grid, and the request to serve it next among those waiting.
 */
interface QueuedGrid {
  grid: Promise<ParsedCsv>;
  /** Moves this read to the next turn, or does nothing once it has one. */
  prioritize: () => void;
}

/** Runs one workbook's sheet reads, one at a time and newest request first. */
type ReadQueue = (read: () => Promise<ParsedCsv>) => QueuedGrid;

/** A read waiting its turn, holding the promise its caller already has. */
interface QueuedRead {
  read: () => Promise<ParsedCsv>;
  resolve: (grid: ParsedCsv) => void;
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
    const grid = new Promise<ParsedCsv>((resolve, reject) => {
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
type GridCache = (index: number, read: () => QueuedGrid) => Promise<ParsedCsv>;

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
): () => Promise<ParsedCsv> {
  return () =>
    cache(index, () => queue(() => readSheetGrid(context, name, target)));
}

export interface ParseWorkbookOptions {
  /** Character cap per inflated part, which tests lower to a readable size. */
  maxPartChars?: number;
}

/**
 * Read a workbook container's metadata into one lazily read sheet per visible
 * sheet. Rejects when the blob is not a zip or carries no `xl/workbook.xml`,
 * which the preview shows as an unreadable file. A sheet whose own part is
 * missing or malformed rejects from its `read`, leaving the rest readable.
 */
export async function parseWorkbook(
  blob: Blob,
  options: ParseWorkbookOptions = {},
): Promise<ParsedWorkbook> {
  const maxPartChars = options.maxPartChars ?? MAX_PART_CHARS;
  // An ArrayBuffer rather than the Blob, so one call covers the browser and
  // the test runner.
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const workbookXml = await readPart(zip, "xl/workbook.xml", maxPartChars);
  if (workbookXml === null) {
    throw new Error("Not a workbook: xl/workbook.xml is missing");
  }

  const { sheets, date1904 } = readWorkbookStructure(workbookXml);
  const relationships = readWorkbookRelationships(
    await readPart(zip, "xl/_rels/workbook.xml.rels", maxPartChars),
  );
  const context: WorkbookContext = {
    zip,
    formatKinds: readNumberFormatKinds(
      await readPart(zip, relationships.styles, maxPartChars),
      relationships.styles,
    ),
    date1904,
    maxPartChars,
    sharedStrings: createSharedStringReader(
      zip,
      relationships.sharedStrings,
      maxPartChars,
    ),
  };

  // A workbook whose sheets are every one hidden still has something to show.
  const visible = sheets.filter((sheet) => !sheet.hidden);
  const kept = visible.length > 0 ? visible : sheets;

  const grids = createGridCache();
  const reads = createReadQueue();
  return {
    sheets: kept.map((sheet, index) => ({
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
