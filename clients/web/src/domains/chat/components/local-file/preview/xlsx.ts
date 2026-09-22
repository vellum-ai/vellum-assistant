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
   * This sheet's grid, read on first call and cached from then on, so repeat
   * calls cost nothing and a failed read stays failed. Sheets are lazy because
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

/** What a cell's number format renders its value as. */
type NumberFormatKind = "none" | "date" | "time" | "datetime";

/**
 * What a built-in `numFmtId` renders. The date ids spell a calendar day, the
 * time ids a clock reading (including the elapsed formats 45 to 47), and 22 is
 * the one built-in that spells both.
 */
function builtInFormatKind(id: number): NumberFormatKind {
  if (
    (id >= 14 && id <= 17) ||
    (id >= 27 && id <= 36) ||
    (id >= 50 && id <= 58)
  ) {
    return "date";
  }
  if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) {
    return "time";
  }
  return id === 22 ? "datetime" : "none";
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

/**
 * What a custom format code renders. Quoted literals, bracketed sections, and
 * backslash escapes can hold any letter without spelling a token, so they come
 * out before the placeholders are read. Bracket removal takes the elapsed
 * tokens (`[h]`, `[mm]`, `[ss]`) with it: elapsed formats reach the time
 * renderer through their built-in ids, and a custom code spelling nothing but
 * elapsed time renders as a plain number.
 */
function formatCodeKind(code: string): NumberFormatKind {
  const tokens = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .toLowerCase();
  let hasDate = /[yd]/.test(tokens);
  let hasTime = /[hs]/.test(tokens);
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
    return hasTime ? "datetime" : "date";
  }
  return hasTime ? "time" : "none";
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
   * Prefix the element at the cut carried, so the tags appended to close the
   * part are spelled the way the part spells them.
   */
  prefix: string;
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
 * element and only the elements still open around it need closing. This is
 * what keeps a sheet with a million rows from being decompressed whole for a
 * preview that shows five thousand. A cap reached before a second marker would
 * leave nothing complete behind, so the read rejects rather than resolving a
 * part that reads as empty.
 */
function readMarkedPart(
  entry: JSZip.JSZipObject,
  marker: PartMarker,
  maxChars: number,
): Promise<BoundedPart> {
  let searchFrom = 0;
  let seen = 0;
  let lastMarkerAt = -1;
  let lastMarkerPrefix = "";

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
          continue;
        }
        seen += 1;
        lastMarkerAt = at;
        lastMarkerPrefix = match.prefix;
        if (seen > marker.limit) {
          settle.resolve({
            xml: buffer.slice(0, at),
            truncated: true,
            prefix: match.prefix,
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
        prefix: lastMarkerPrefix,
      });
    },
    onEnd: (buffer) => ({ xml: buffer, truncated: false, prefix: "" }),
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
 * first and spelled with the prefix the part carries.
 */
function closeBoundedPart(part: BoundedPart, stillOpen: string[]): string {
  if (!part.truncated) {
    return part.xml;
  }
  const closing = stillOpen.map((name) => `</${part.prefix}${name}>`).join("");
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

/** Relationship id to the part path it points at, rooted at the zip. */
function readRelationshipTargets(xml: string | null): Map<string, string> {
  const targets = new Map<string, string>();
  if (xml === null) {
    return targets;
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
    targets.set(
      id,
      decoded.startsWith("/")
        ? resolveZipPath("", decoded.slice(1))
        : resolveZipPath("xl/", decoded),
    );
  }
  return targets;
}

/** Per `cellXfs` index, what cells carrying that style render as. */
function readNumberFormatKinds(xml: string | null): NumberFormatKind[] {
  if (xml === null) {
    return [];
  }
  const root = parseXml(xml, "xl/styles.xml");
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
  const kind = formatKinds[Number(cell.getAttribute("s") ?? "0")] ?? "none";
  if (kind !== "none" && isDateSerial(asNumber, date1904)) {
    return formatSerial(asNumber, kind, date1904);
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
  highestIndex: number,
  maxPartChars: number,
): Promise<SharedStringTable> {
  const entry = zip.file("xl/sharedStrings.xml");
  if (entry === null) {
    return { strings: [], readUpTo: highestIndex, exhausted: true };
  }
  const part = await readMarkedPart(
    entry,
    { localName: "si", limit: highestIndex + 1 },
    maxPartChars,
  );
  const root = parseXml(
    closeBoundedPart(part, ["sst"]),
    "xl/sharedStrings.xml",
  );
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
 * otherwise inflate the same part twice.
 */
function createSharedStringReader(
  zip: JSZip,
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
        table = await readSharedStringTable(zip, highestIndex, maxPartChars);
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
    context.maxPartChars,
  );
  const read = readSheetRows(
    parseXml(closeBoundedPart(part, ["sheetData", "worksheet"]), entry.name),
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
    part.truncated || read.truncated || lostSharedString,
  );
}

/** A sheet's `read`, holding the first call's promise for every later one. */
function createSheetReader(
  context: WorkbookContext,
  name: string,
  target: string | undefined,
): () => Promise<ParsedCsv> {
  let pending: Promise<ParsedCsv> | null = null;
  return () => {
    pending ??= readSheetGrid(context, name, target);
    return pending;
  };
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
  const targets = readRelationshipTargets(
    await readPart(zip, "xl/_rels/workbook.xml.rels", maxPartChars),
  );
  const context: WorkbookContext = {
    zip,
    formatKinds: readNumberFormatKinds(
      await readPart(zip, "xl/styles.xml", maxPartChars),
    ),
    date1904,
    maxPartChars,
    sharedStrings: createSharedStringReader(zip, maxPartChars),
  };

  // A workbook whose sheets are every one hidden still has something to show.
  const visible = sheets.filter((sheet) => !sheet.hidden);
  const kept = visible.length > 0 ? visible : sheets;

  return {
    sheets: kept.map((sheet) => ({
      name: sheet.name,
      read: createSheetReader(
        context,
        sheet.name,
        sheet.relationshipId === null
          ? undefined
          : targets.get(sheet.relationshipId),
      ),
    })),
  };
}
