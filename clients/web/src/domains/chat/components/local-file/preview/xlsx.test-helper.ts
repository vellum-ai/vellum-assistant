/**
 * Builds `.xlsx` containers in memory so a test states a workbook as sheets of
 * plain cells instead of carrying a binary fixture into the repo.
 */

import JSZip from "jszip";

/** Namespaces an OOXML workbook declares, which raw parts spell out too. */
export const MAIN_NS =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PACKAGE_RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";

/** A string cell: plain text, or the runs a rich-text cell is split into. */
type TextSpec = string | { runs: string[] };

interface CellSpec {
  /** Cell type attribute, such as `s`, `b`, `e`, or `str`. */
  t?: string;
  /** Cached value, written as `<v>`. */
  v?: string | number;
  /** Formula text, written as `<f>`. */
  f?: string;
  /** Style index into the workbook's `styles`. */
  s?: number;
  /** Inline string contents, which also sets `t="inlineStr"`. */
  inline?: string;
  /** Write the cell without its `r` reference. */
  noRef?: boolean;
}

/** A string is an inline string, a number a numeric cell, `null` a gap. */
export type CellInput = string | number | CellSpec | null;

export interface SheetSpec {
  name: string;
  rows?: CellInput[][];
  hidden?: "hidden" | "veryHidden";
  /** Raw XML written after the rows and inside `<sheetData>`. */
  trailing?: string;
  /** Raw XML written after `</sheetData>`, where a worksheet's sections sit. */
  afterSheetData?: string;
}

/** One `cellXfs` entry: a built-in format id, or a custom format code. */
interface StyleSpec {
  numFmtId?: number;
  formatCode?: string;
}

export interface WorkbookSpec {
  sheets: SheetSpec[];
  sharedStrings?: TextSpec[];
  styles?: StyleSpec[];
  date1904?: boolean;
  /**
   * Raw parts written over the generated ones, for a container the spec cannot
   * state: an odd relationship target, or a styles table with its own blocks.
   */
  parts?: Record<string, string>;
}

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
  return `${DECLARATION}<worksheet xmlns="${MAIN_NS}"><sheetData>${rows}${spec.trailing ?? ""}</sheetData>${spec.afterSheetData ?? ""}</worksheet>`;
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

function relationshipsXml(spec: WorkbookSpec): string {
  const relationships = spec.sheets.map((_, index) => {
    return `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIP_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`;
  });
  // A container that carries these parts points at them from here.
  const relate = (type: string, target: string): void => {
    relationships.push(
      `<Relationship Id="rId${relationships.length + 1}" Type="${RELATIONSHIP_NS}/${type}" Target="${target}"/>`,
    );
  };
  if (spec.sharedStrings !== undefined) {
    relate("sharedStrings", "sharedStrings.xml");
  }
  if (spec.styles !== undefined) {
    relate("styles", "styles.xml");
  }
  return `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">${relationships.join("")}</Relationships>`;
}

/** The package relationship part, which points at the workbook. */
function packageRelationshipsXml(): string {
  return `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
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

/**
 * A container holding exactly these parts, deflated like a real workbook.
 * `comment` is the trailing zip comment, which a container may carry and the
 * entry count sits in front of.
 */
export async function partsBlob(
  parts: Record<string, string>,
  comment?: string,
): Promise<Blob> {
  const zip = new JSZip();
  for (const [path, xml] of Object.entries(parts)) {
    zip.file(path, xml);
  }
  // Deflated like a real workbook, so a bounded read has something to skip.
  const buffer = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    comment,
  });
  return new Blob([buffer]);
}

/** An `.xlsx` container holding `spec`, ready to hand to `parseWorkbook`. */
export async function workbookBlob(spec: WorkbookSpec): Promise<Blob> {
  const parts: Record<string, string> = {
    "_rels/.rels": packageRelationshipsXml(),
    "xl/workbook.xml": workbookXml(spec),
    "xl/_rels/workbook.xml.rels": relationshipsXml(spec),
  };
  spec.sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(sheet);
  });
  if (spec.sharedStrings !== undefined) {
    parts["xl/sharedStrings.xml"] = sharedStringsXml(spec.sharedStrings);
  }
  if (spec.styles !== undefined) {
    parts["xl/styles.xml"] = stylesXml(spec.styles);
  }
  return partsBlob({ ...parts, ...spec.parts });
}
