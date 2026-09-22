/**
 * Builds `.xlsx` containers in memory so a test states a workbook as sheets of
 * plain cells instead of carrying a binary fixture into the repo.
 */

import JSZip from "jszip";

/** A string cell: plain text, or the runs a rich-text cell is split into. */
export type TextSpec = string | { runs: string[] };

export interface CellSpec {
  /** Cell type attribute, such as `s`, `b`, `e`, or `str`. */
  t?: string;
  /** Cached value, written as `<v>`. */
  v?: string | number;
  /** Formula text, written as `<f>`. */
  f?: string;
  /** Style index into the workbook's `styles`. */
  s?: number;
  /** Inline string contents, which also sets `t="inlineStr"`. */
  inline?: TextSpec;
  /** Write the cell without its `r` reference. */
  noRef?: boolean;
}

/** A string is an inline string, a number a numeric cell, `null` a gap. */
export type CellInput = string | number | CellSpec | null;

export interface SheetSpec {
  name: string;
  rows?: CellInput[][];
  hidden?: "hidden" | "veryHidden";
  /** Raw XML written after the rows, for stating what a bounded read skips. */
  trailing?: string;
}

/** One `cellXfs` entry: a built-in format id, or a custom format code. */
export interface StyleSpec {
  numFmtId?: number;
  formatCode?: string;
}

export interface WorkbookSpec {
  sheets: SheetSpec[];
  sharedStrings?: TextSpec[];
  styles?: StyleSpec[];
  date1904?: boolean;
}

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Column reference for a zero-based index: 0 is `A`, 26 is `AA`. */
function columnRef(index: number): string {
  let ref = "";
  let remaining = index;
  while (remaining >= 0) {
    ref = String.fromCharCode(65 + (remaining % 26)) + ref;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return ref;
}

function textXml(spec: TextSpec): string {
  if (typeof spec === "string") {
    return `<t xml:space="preserve">${escapeXml(spec)}</t>`;
  }
  return spec.runs
    .map((run) => `<r><t xml:space="preserve">${escapeXml(run)}</t></r>`)
    .join("");
}

function toCellSpec(input: string | number | CellSpec): CellSpec {
  if (typeof input === "string") {
    return { inline: input };
  }
  if (typeof input === "number") {
    return { v: input };
  }
  return input;
}

function cellXml(
  input: CellInput,
  rowNumber: number,
  columnIndex: number,
): string {
  if (input === null) {
    return "";
  }
  const spec = toCellSpec(input);
  const ref =
    spec.noRef === true ? "" : ` r="${columnRef(columnIndex)}${rowNumber}"`;
  const type =
    spec.inline !== undefined
      ? ' t="inlineStr"'
      : spec.t !== undefined
        ? ` t="${spec.t}"`
        : "";
  const style = spec.s === undefined ? "" : ` s="${spec.s}"`;
  const body = [
    spec.f === undefined ? "" : `<f>${escapeXml(spec.f)}</f>`,
    spec.inline === undefined ? "" : `<is>${textXml(spec.inline)}</is>`,
    spec.v === undefined ? "" : `<v>${escapeXml(String(spec.v))}</v>`,
  ].join("");
  return body === ""
    ? `<c${ref}${type}${style}/>`
    : `<c${ref}${type}${style}>${body}</c>`;
}

function sheetXml(spec: SheetSpec): string {
  const rows = (spec.rows ?? [])
    .map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const body = cells
        .map((cell, columnIndex) => cellXml(cell, rowNumber, columnIndex))
        .join("");
      return `<row r="${rowNumber}">${body}</row>`;
    })
    .join("");
  return `${DECLARATION}<worksheet xmlns="${MAIN_NS}"><sheetData>${rows}${spec.trailing ?? ""}</sheetData></worksheet>`;
}

function workbookXml(spec: WorkbookSpec): string {
  const properties = spec.date1904 === true ? '<workbookPr date1904="1"/>' : "";
  const sheets = spec.sheets
    .map((sheet, index) => {
      const state =
        sheet.hidden === undefined ? "" : ` state="${sheet.hidden}"`;
      return `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"${state}/>`;
    })
    .join("");
  return `${DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${RELATIONSHIP_NS}">${properties}<sheets>${sheets}</sheets></workbook>`;
}

function relationshipsXml(sheetCount: number): string {
  const relationships = Array.from({ length: sheetCount }, (_, index) => {
    return `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIP_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`;
  }).join("");
  return `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">${relationships}</Relationships>`;
}

function sharedStringsXml(strings: TextSpec[]): string {
  const items = strings.map((entry) => `<si>${textXml(entry)}</si>`).join("");
  return `${DECLARATION}<sst xmlns="${MAIN_NS}" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function stylesXml(styles: StyleSpec[]): string {
  const customFormats: string[] = [];
  let nextCustomId = 164;
  const cellXfs = styles
    .map((style) => {
      if (style.formatCode === undefined) {
        return `<xf numFmtId="${style.numFmtId ?? 0}"/>`;
      }
      const id = nextCustomId;
      nextCustomId += 1;
      customFormats.push(
        `<numFmt numFmtId="${id}" formatCode="${escapeXml(style.formatCode)}"/>`,
      );
      return `<xf numFmtId="${id}" applyNumberFormat="1"/>`;
    })
    .join("");
  // A `cellStyleXfs` block sits beside `cellXfs` in every real workbook, so
  // the reader has to pick the right one.
  return `${DECLARATION}<styleSheet xmlns="${MAIN_NS}"><numFmts count="${customFormats.length}">${customFormats.join("")}</numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="${styles.length}">${cellXfs}</cellXfs></styleSheet>`;
}

/** An `.xlsx` container holding `spec`, ready to hand to `parseWorkbook`. */
export async function workbookBlob(spec: WorkbookSpec): Promise<Blob> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", workbookXml(spec));
  zip.file("xl/_rels/workbook.xml.rels", relationshipsXml(spec.sheets.length));
  spec.sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet));
  });
  if (spec.sharedStrings !== undefined) {
    zip.file("xl/sharedStrings.xml", sharedStringsXml(spec.sharedStrings));
  }
  if (spec.styles !== undefined) {
    zip.file("xl/styles.xml", stylesXml(spec.styles));
  }
  // Deflated like a real workbook, so a bounded read has something to skip.
  const buffer = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
  return new Blob([buffer]);
}
