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
  looksLikeHeader,
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
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

/** Whether a built-in `numFmtId` renders a date or a time. */
function isBuiltInDateFormat(id: number): boolean {
  return (
    (id >= 14 && id <= 22) ||
    (id >= 27 && id <= 36) ||
    (id >= 45 && id <= 47) ||
    (id >= 50 && id <= 58)
  );
}

/** Local part of a qualified name, so `rel:id` and `id` both read as `id`. */
function localPart(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Descendants of `parent` with this local name. A producer picks its own
 * OOXML prefixes, so nothing can be matched by qualified name. The scan
 * filters `getElementsByTagName("*")` rather than calling
 * `getElementsByTagNameNS("*", name)` because happy-dom, which the tests run
 * on, returns nothing for the wildcard namespace; filtering on `localName`
 * behaves the same there and in browsers, and measures no slower.
 */
function childrenNamed(
  parent: Document | Element,
  localName: string,
): Element[] {
  return Array.from(parent.getElementsByTagName("*")).filter(
    (element) => element.localName === localName,
  );
}

/**
 * An attribute's value by local name, whatever prefix carries it. When
 * `namespaceUri` is given the attribute declared in that namespace wins, and a
 * bare local-name match is the fallback: happy-dom reports no namespace on an
 * attribute and leaves the prefix on its `localName`.
 */
function attributeNamed(
  element: Element,
  localName: string,
  namespaceUri?: string,
): string | null {
  let fallback: string | null = null;
  for (const attribute of Array.from(element.attributes)) {
    if (localPart(attribute.localName) !== localName) {
      continue;
    }
    if (namespaceUri === undefined || attribute.namespaceURI === namespaceUri) {
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
function parseXml(xml: string, part: string): Document {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`Malformed XML in ${part}`);
  }
  return doc;
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
export const MAX_PART_CHARS = 64 * 1024 * 1024;

interface BoundedPart {
  xml: string;
  /** True when the read stopped before the end of the part. */
  truncated: boolean;
}

interface BoundedRead {
  /**
   * Element start tag the read cuts at, kept `limit` times. The tag is the
   * unprefixed spelling every writer emits, so a part that prefixes it is
   * bounded by `maxChars` alone. A read with no marker has nowhere safe to
   * cut, so it rejects at the cap instead.
   */
  marker?: { text: string; limit: number };
  maxChars: number;
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
 * Inflate `entry` only until the marker has been seen `limit` times or the
 * text passes `maxChars`, then cut it and abandon the rest of the stream.
 * Either cut lands at the start of a marker, so the text ends on a complete
 * element. This is what keeps a sheet with a million rows from being
 * decompressed whole for a preview that shows five thousand. A markerless read
 * wants the whole part, so passing the cap rejects instead.
 */
function readBoundedPart(
  entry: JSZip.JSZipObject,
  read: BoundedRead,
): Promise<BoundedPart> {
  return new Promise((resolve, reject) => {
    const marker = read.marker;
    const stream = (entry as StreamingEntry).internalStream("string");
    let buffer = "";
    let searchFrom = 0;
    let seen = 0;
    let lastMarkerAt = -1;
    let settled = false;

    const stop = (): void => {
      settled = true;
      stream.pause();
    };

    /** Cut at the start of a marker, or empty when none was reached. */
    const cutAt = (at: number): void => {
      stop();
      resolve({ xml: at < 0 ? "" : buffer.slice(0, at), truncated: true });
    };

    stream.on("data", (chunk) => {
      if (settled) {
        return;
      }
      buffer += chunk;
      if (marker !== undefined) {
        for (;;) {
          const at = buffer.indexOf(marker.text, searchFrom);
          if (at === -1) {
            // Only a partial marker can still be pending at the tail, so the
            // next chunk does not need the whole buffer rescanned.
            searchFrom = Math.max(
              searchFrom,
              buffer.length - marker.text.length + 1,
            );
            break;
          }
          const after = buffer[at + marker.text.length];
          if (after === undefined) {
            // The character that would settle this match has not arrived, so
            // the next chunk decides it rather than this one guessing.
            searchFrom = at;
            break;
          }
          searchFrom = at + marker.text.length;
          if (!endsTagName(after)) {
            continue;
          }
          seen += 1;
          lastMarkerAt = at;
          if (seen > marker.limit) {
            cutAt(at);
            return;
          }
        }
      }
      if (buffer.length <= read.maxChars) {
        return;
      }
      if (marker === undefined) {
        stop();
        reject(new Error(`${entry.name} is too large to read`));
        return;
      }
      cutAt(lastMarkerAt);
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
        resolve({ xml: buffer, truncated: false });
      }
    });
    stream.resume();
  });
}

/**
 * Read a metadata part whole, or `null` when the workbook leaves it out. These
 * parts steer every later read, so one that inflates past `maxChars` rejects:
 * a cut workbook or style table is worse than no preview at all.
 */
async function readPart(
  zip: JSZip,
  path: string,
  maxChars: number,
): Promise<string | null> {
  const entry = zip.file(path);
  if (entry === null) {
    return null;
  }
  const { xml } = await readBoundedPart(entry, { maxChars });
  return xml;
}

/**
 * XML for a part a bounded read may have cut. A cut part is missing the tags
 * that close it, and one cut before its first marker has no body at all.
 */
function closeBoundedPart(
  part: BoundedPart,
  empty: string,
  closing: string,
): string {
  if (!part.truncated) {
    return part.xml;
  }
  return part.xml === "" ? empty : `${part.xml}${closing}`;
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
  const doc = parseXml(xml, "xl/workbook.xml");
  const dateMode = childrenNamed(doc, "workbookPr")[0]?.getAttribute(
    "date1904",
  );
  const sheets = childrenNamed(doc, "sheet").map((sheet) => {
    const state = sheet.getAttribute("state");
    return {
      name: sheet.getAttribute("name") ?? "",
      relationshipId: attributeNamed(sheet, "id", RELATIONSHIP_NS),
      hidden: state === "hidden" || state === "veryHidden",
    };
  });
  return { sheets, date1904: dateMode === "1" || dateMode === "true" };
}

/** Relationship id to the part path it points at, rooted at the zip. */
function readRelationshipTargets(xml: string | null): Map<string, string> {
  const targets = new Map<string, string>();
  if (xml === null) {
    return targets;
  }
  const doc = parseXml(xml, "xl/_rels/workbook.xml.rels");
  for (const relationship of childrenNamed(doc, "Relationship")) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id === null || target === null) {
      continue;
    }
    // A relative target is relative to the part that declares it.
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  return targets;
}

/**
 * Whether a custom format code renders a date. Quoted literals, bracketed
 * sections, and backslash escapes can hold any letter without meaning a date,
 * so they come out before the date placeholders are looked for.
 */
function formatCodeIsDate(code: string): boolean {
  const placeholders = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(placeholders);
}

/** Per `cellXfs` index, whether cells carrying that style render as a date. */
function readDateStyles(xml: string | null): boolean[] {
  if (xml === null) {
    return [];
  }
  const doc = parseXml(xml, "xl/styles.xml");
  const customFormats = new Map<number, string>();
  for (const format of childrenNamed(doc, "numFmt")) {
    const id = Number(format.getAttribute("numFmtId"));
    const code = format.getAttribute("formatCode");
    if (Number.isInteger(id) && code !== null) {
      customFormats.set(id, code);
    }
  }
  const cellXfs = childrenNamed(doc, "cellXfs")[0];
  if (cellXfs === undefined) {
    return [];
  }
  return childrenNamed(cellXfs, "xf").map((xf) => {
    const id = Number(xf.getAttribute("numFmtId") ?? "0");
    if (isBuiltInDateFormat(id)) {
      return true;
    }
    const code = customFormats.get(id);
    return code === undefined ? false : formatCodeIsDate(code);
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Render a date serial as `yyyy-mm-dd`, plus ` hh:mm` when the serial carries
 * a time. The 1900 workbook counts a 29 February 1900 that never existed, so
 * serials below 60 sit one day behind the real calendar, and serial 60 is that
 * phantom day itself. Excel shows it as 1900-02-29, so it is written out: no
 * `Date` can hold it, and computing it would collapse it onto serial 59.
 */
function formatDateSerial(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = !date1904 && serial < 60 ? serial + 1 : serial;
  const at = epoch + Math.round(days * MS_PER_DAY);
  const moment = new Date(at);
  const time =
    at % MS_PER_DAY === 0
      ? ""
      : ` ${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}`;
  if (!date1904 && serial >= 60 && serial < 61) {
    return `1900-02-29${time}`;
  }
  const day = `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}`;
  return `${day}${time}`;
}

interface SharedStringRef {
  sharedIndex: number;
}

/**
 * A cell is either finished text or a pointer into the shared string table,
 * which is read only as far as the sheet pointing into it reaches.
 */
type RawCell = string | SharedStringRef;

function isSharedStringRef(cell: RawCell): cell is SharedStringRef {
  return typeof cell !== "string";
}

/** Text of the `<v>` child, or `null` when the cell holds no cached value. */
function cachedValue(cell: Element): string | null {
  const value = childrenNamed(cell, "v")[0];
  return value === undefined ? null : (value.textContent ?? "");
}

/** Every `<t>` descendant joined, which is how a rich-text run reads. */
function joinTextRuns(element: Element | undefined): string {
  if (element === undefined) {
    return "";
  }
  return childrenNamed(element, "t")
    .map((run) => run.textContent ?? "")
    .join("");
}

function readCell(
  cell: Element,
  isDateStyle: boolean[],
  date1904: boolean,
): RawCell {
  const type = cell.getAttribute("t");
  if (type === "s") {
    const index = Number(cachedValue(cell));
    return Number.isInteger(index) && index >= 0 ? { sharedIndex: index } : "";
  }
  if (type === "inlineStr") {
    return joinTextRuns(childrenNamed(cell, "is")[0]);
  }

  const value = cachedValue(cell);
  const hasResult = value !== null && value !== "";
  if (!hasResult) {
    // openpyxl writes an unevaluated formula with no cached result, or with an
    // empty one, so an empty `<v>` means no result rather than zero or false.
    // This runs before the typed branches because the cell's declared type
    // says nothing about whether it was evaluated, and showing the formula
    // beats showing a blank where the user knows there is data.
    const formula = childrenNamed(cell, "f")[0];
    if (formula !== undefined) {
      return `=${formula.textContent ?? ""}`;
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
  const styleIndex = Number(cell.getAttribute("s") ?? "0");
  if (isDateStyle[styleIndex] === true) {
    return formatDateSerial(asNumber, date1904);
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
  doc: Document,
  isDateStyle: boolean[],
  date1904: boolean,
): SheetRows {
  const rows: RawCell[][] = [];
  let truncated = false;
  let highestSharedIndex = -1;

  for (const row of childrenNamed(doc, "row")) {
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
    for (const cell of childrenNamed(row, "c")) {
      column = columnIndexFromRef(cell.getAttribute("r")) ?? column + 1;
      if (column >= MAX_CSV_COLUMNS) {
        truncated = true;
        continue;
      }
      // Excel omits empty cells, so a jump in the reference leaves a gap.
      while (cells.length < column) {
        cells.push("");
      }
      const parsed = readCell(cell, isDateStyle, date1904);
      if (isSharedStringRef(parsed)) {
        highestSharedIndex = Math.max(highestSharedIndex, parsed.sharedIndex);
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
  const part = await readBoundedPart(entry, {
    marker: { text: "<si", limit: highestIndex + 1 },
    maxChars: maxPartChars,
  });
  const doc = parseXml(
    closeBoundedPart(part, "<sst/>", "</sst>"),
    "xl/sharedStrings.xml",
  );
  return {
    strings: childrenNamed(doc, "si").map((item) => joinTextRuns(item)),
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

/** Pad ragged rows to a common width and pick a header, as `parseCsv` does. */
function shapeGrid(records: string[][], truncated: boolean): ParsedCsv {
  if (records.length === 0) {
    return { headers: null, rows: [], truncated };
  }
  const width = records.reduce((max, row) => Math.max(max, row.length), 0);
  const shaped = records.map((row) => {
    const cells = row.slice();
    while (cells.length < width) {
      cells.push("");
    }
    return cells;
  });
  const hasHeader = looksLikeHeader(shaped);
  return {
    headers: hasHeader ? shaped[0]! : null,
    rows: hasHeader ? shaped.slice(1) : shaped,
    truncated,
  };
}

/** What every sheet of one workbook shares while it reads its own part. */
interface WorkbookContext {
  zip: JSZip;
  isDateStyle: boolean[];
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
  const part = await readBoundedPart(entry, {
    marker: { text: "<row", limit: MAX_CSV_ROWS },
    maxChars: context.maxPartChars,
  });
  const read = readSheetRows(
    parseXml(
      closeBoundedPart(part, "<worksheet/>", "</sheetData></worksheet>"),
      entry.name,
    ),
    context.isDateStyle,
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
      if (!isSharedStringRef(cell)) {
        return cell;
      }
      const text = strings[cell.sharedIndex];
      if (text === undefined) {
        lostSharedString = true;
        return "";
      }
      return text;
    }),
  );
  return shapeGrid(
    records,
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
    isDateStyle: readDateStyles(
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
