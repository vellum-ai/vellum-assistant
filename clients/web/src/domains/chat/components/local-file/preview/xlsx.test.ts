import { describe, expect, spyOn, test } from "bun:test";
import JSZip from "jszip";

import {
  MAX_CSV_ROWS,
  parseCsv,
} from "@/domains/chat/components/local-file/preview/csv";
import {
  MAX_CACHED_SHEETS,
  MAX_CELL_FORMATS,
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_WORKBOOK_SHEETS,
  parseWorkbook,
  type ParsedWorkbook,
  type ParseWorkbookOptions,
  type SheetGrid,
} from "@/domains/chat/components/local-file/preview/xlsx";
import {
  MAIN_NS,
  PACKAGE_RELATIONSHIP_NS,
  partsBlob,
  RELATIONSHIP_NS,
  workbookBlob,
  type CellInput,
  type SheetSpec,
  type WorkbookSpec,
} from "@/domains/chat/components/local-file/preview/xlsx.test-helper";

/** The one sheet of a workbook built from `rows`, plus any workbook extras. */
async function readOneSheet(
  rows: CellInput[][],
  extras: Omit<WorkbookSpec, "sheets"> = {},
  options?: ParseWorkbookOptions,
): Promise<SheetGrid> {
  const parsed = await parseWorkbook(
    await workbookBlob({ sheets: [{ name: "Sheet1", rows }], ...extras }),
    options,
  );
  return parsed.sheets[0]!.read();
}

/** A workbook of `count` sheets, each holding one cell naming the sheet. */
async function workbookOfSheets(count: number): Promise<ParsedWorkbook> {
  return parseWorkbook(
    await workbookBlob({
      sheets: Array.from({ length: count }, (_, index) => ({
        name: `Sheet${index + 1}`,
        rows: [[`cell ${index + 1}`]],
      })),
    }),
  );
}

/** The one sheet of a workbook, for a sheet that states its own raw XML. */
async function readSheetSpec(sheet: SheetSpec): Promise<SheetGrid> {
  const parsed = await parseWorkbook(await workbookBlob({ sheets: [sheet] }));
  return parsed.sheets[0]!.read();
}

/** A date format code long enough to push `xl/styles.xml` past a small cap. */
const LONG_DATE_FORMAT = `yyyy-mm-dd${"0".repeat(50_000)}`;

/** A row at `position` holding one inline string, as raw worksheet XML. */
function rowXml(position: number, text: string): string {
  return `<row r="${position}"><c r="A${position}" t="inlineStr"><is><t>${text}</t></is></c></row>`;
}

/** A worksheet part holding exactly these rows. */
function sheetXml(rows: string): string {
  return `<worksheet xmlns="${MAIN_NS}"><sheetData>${rows}</sheetData></worksheet>`;
}

/** A worksheet part that states `ref` as its used range before its rows. */
function dimensionSheetXml(ref: string, rows: string): string {
  return `<worksheet xmlns="${MAIN_NS}"><dimension ref="${ref}"/><sheetData>${rows}</sheetData></worksheet>`;
}

/** The section a worksheet writes after its rows, whose name starts with `row`. */
const ROW_BREAKS =
  '<rowBreaks count="1" manualBreakCount="1"><brk id="10" max="16383" man="1"/></rowBreaks>';

/** A one-sheet relationship part pointing at `target`. */
function relationshipsXml(target: string): string {
  return `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/worksheet" Target="${target}"/></Relationships>`;
}

/** The namespace strict OOXML roots its relationship types at. */
const STRICT_RELATIONSHIP_NS =
  "http://purl.oclc.org/ooxml/officeDocument/relationships";

/** The same part, plus a relationship of `type` pointing at `target`. */
function relationshipsXmlWith(type: string, target: string): string {
  return `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${type}" Target="${target}"/></Relationships>`;
}

/** A shared string table holding one string, as a raw part. */
function oneSharedStringXml(text: string): string {
  return `<sst xmlns="${MAIN_NS}" count="1" uniqueCount="1"><si><t>${text}</t></si></sst>`;
}

/** A styles table whose second `cellXfs` entry renders a cell as a date. */
const DATE_STYLES = `<styleSheet xmlns="${MAIN_NS}"><numFmts count="0"/><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

/** A cell that never closes, which a DOM built over it rejects. */
const UNCLOSED_CELL = "<c><v>1</v>";

/** The same cell, spelled with `prefix`. */
function prefixedUnclosedCell(prefix = "x"): string {
  return `<${prefix}:c><${prefix}:v>1</${prefix}:v>`;
}

/** An inline-string cell holding `text` raw, for CDATA and comment content. */
function rawInlineCellXml(text: string): string {
  return `<c t="inlineStr"><is><t>${text}</t></is></c>`;
}

/** A row of `count` numeric cells, followed by the raw XML in `trailing`. */
function wideRowXml(position: number, count: number, trailing = ""): string {
  return `<row r="${position}">${"<c><v>1</v></c>".repeat(count)}${trailing}</row>`;
}

/** The same row, spelled with a prefix on the row and on every cell. */
function prefixedWideRowXml(
  position: number,
  count: number,
  trailing = "",
  prefix = "x",
): string {
  return `<${prefix}:row r="${position}">${`<${prefix}:c><${prefix}:v>1</${prefix}:v></${prefix}:c>`.repeat(
    count,
  )}${trailing}</${prefix}:row>`;
}

/**
 * A styles table whose `dxfs` block reuses the id its `numFmts` block defines,
 * which is how conditional formatting collides with a real custom format.
 */
const COLLIDING_DXF_STYLES = `<styleSheet xmlns="${MAIN_NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="1"><xf numFmtId="164" applyNumberFormat="1"/></cellXfs><dxfs count="1"><dxf><numFmt numFmtId="164" formatCode="0.00"/></dxf></dxfs></styleSheet>`;

/** A shared string table carrying a phonetic guide and a rich-text run. */
const PHONETIC_SHARED_STRINGS = `<sst xmlns="${MAIN_NS}" count="2" uniqueCount="2"><si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh><phoneticPr fontId="1"/></si><si><r><t>a</t></r><r><t>b</t></r></si></sst>`;

/** Cells the prefixed and unprefixed fixtures both spell, as the helper states them. */
const PREFIX_FIXTURE_ROW: CellInput[] = [
  { t: "s", v: 0 },
  "inline",
  { v: 44927, s: 0 },
  { f: "SUM(A1:A2)" },
];

/**
 * The same workbook, written with a prefix on every element and on the
 * relationship attribute. OOXML lets a producer pick its own prefixes, so
 * nothing may be matched by qualified name.
 */
function prefixedWorkbookParts(): Record<string, string> {
  return {
    "xl/workbook.xml": `<x:workbook xmlns:x="${MAIN_NS}" xmlns:rel="${RELATIONSHIP_NS}"><x:sheets><x:sheet name="Data" sheetId="1" rel:id="rId1"/></x:sheets></x:workbook>`,
    "xl/_rels/workbook.xml.rels": `<pkg:Relationships xmlns:pkg="${PACKAGE_RELATIONSHIP_NS}"><pkg:Relationship Id="rId1" Type="${RELATIONSHIP_NS}/worksheet" Target="worksheets/sheet1.xml"/></pkg:Relationships>`,
    "xl/worksheets/sheet1.xml": `<x:worksheet xmlns:x="${MAIN_NS}"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="inlineStr"><x:is><x:t xml:space="preserve">inline</x:t></x:is></x:c><x:c r="C1" s="0"><x:v>44927</x:v></x:c><x:c r="D1"><x:f>SUM(A1:A2)</x:f></x:c></x:row></x:sheetData></x:worksheet>`,
    "xl/sharedStrings.xml": `<x:sst xmlns:x="${MAIN_NS}" count="1" uniqueCount="1"><x:si><x:t xml:space="preserve">shared</x:t></x:si></x:sst>`,
    "xl/styles.xml": `<x:styleSheet xmlns:x="${MAIN_NS}"><x:numFmts count="0"/><x:cellStyleXfs count="1"><x:xf numFmtId="0"/></x:cellStyleXfs><x:cellXfs count="1"><x:xf numFmtId="14"/></x:cellXfs></x:styleSheet>`,
  };
}

/** `count` prefixed rows of one inline string each. */
function prefixedRowsXml(count: number, prefix = "x"): string {
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    return `<${prefix}:row r="${position}"><${prefix}:c r="A${position}" t="inlineStr"><${prefix}:is><${prefix}:t>row ${index}</${prefix}:t></${prefix}:is></${prefix}:c></${prefix}:row>`;
  }).join("");
}

/** A prefixed worksheet part holding the raw `rows`. */
function prefixedSheetPartXml(rows: string, prefix = "x"): string {
  return `<${prefix}:worksheet xmlns:${prefix}="${MAIN_NS}"><${prefix}:sheetData>${rows}</${prefix}:sheetData></${prefix}:worksheet>`;
}

/** A prefixed worksheet part holding `count` rows of one inline string each. */
function prefixedSheetXml(count: number, prefix = "x"): string {
  return prefixedSheetPartXml(prefixedRowsXml(count, prefix), prefix);
}

/**
 * The same rows under a `<worksheet>` and a `<sheetData>` carrying no prefix,
 * which is legal while they share the row's namespace. A cut in here can only
 * be closed with each ancestor's own spelling.
 */
function mixedPrefixSheetXml(count: number): string {
  return `<worksheet xmlns="${MAIN_NS}" xmlns:x="${MAIN_NS}"><sheetData>${prefixedRowsXml(count)}</sheetData></worksheet>`;
}

/** The batch these tests ask a streamed read for, so a tag can straddle one. */
const STREAM_BATCH_CHARS = 16_384;

/**
 * How far before a chunk boundary `<y:sheetData` starts. The scan reads the
 * prefix, rules `row` out on the characters after it, and then runs out of
 * buffer partway through `sheetData`.
 */
const ANCESTOR_STRADDLE_CHARS = 10;

/**
 * Rows under an ancestor whose start tag straddles a chunk boundary. The
 * ancestor carries a prefix of its own, so a cut that closes it with the
 * row marker's prefix instead leaves the part malformed.
 */
function straddledAncestorSheetXml(count: number): string {
  const open = `<worksheet xmlns="${MAIN_NS}" xmlns:x="${MAIN_NS}" xmlns:y="${MAIN_NS}">`;
  const opensAt = STREAM_BATCH_CHARS - ANCESTOR_STRADDLE_CHARS;
  const padding = "p".repeat(opensAt - open.length - "<!---->".length);
  return `${open}<!--${padding}--><y:sheetData>${prefixedRowsXml(count)}</y:sheetData></worksheet>`;
}

/** A comment spelling `count` row markers, which open no row of their own. */
function rowMarkerComment(count: number): string {
  return `<!--${"<row/>".repeat(count)}-->`;
}

/** Rows behind such a comment, whose `<!--` opens at `commentAt`. */
function straddledCommentSheetXml(commentAt: number, markers: number): string {
  const open = `<worksheet xmlns="${MAIN_NS}"><sheetData>`;
  const first = rowXml(1, "alpha");
  const padding = "p".repeat(
    commentAt - open.length - first.length - "<!---->".length,
  );
  return `${open}${first}<!--${padding}-->${rowMarkerComment(markers)}${rowXml(
    2,
    "beta",
  )}</sheetData></worksheet>`;
}

/** A package of four parts and the one folder they sit in, five entries. */
function flatPackageParts(): Record<string, string> {
  return {
    "_rels/.rels": `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/officeDocument" Target="wb.xml"/></Relationships>`,
    "wb.xml": workbookPartXml(),
    "_rels/wb.xml.rels": `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/worksheet" Target="s1.xml"/></Relationships>`,
    "s1.xml": sheetXml(rowXml(1, "alpha")),
  };
}

/** Where the last end of central directory record sits, as a reader looks. */
function lastRecordAt(view: DataView): number {
  for (let at = view.byteLength - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      return at;
    }
  }
  return -1;
}

/**
 * The same container with a second end of central directory record after it,
 * declaring `count` entries while naming the directory the first one names,
 * which is what a reader walks whatever the count says.
 */
async function withTrailingRecord(blob: Blob, count: number): Promise<Blob> {
  const original = new Uint8Array(await blob.arrayBuffer());
  const directoryAt = new DataView(original.buffer).getUint32(
    lastRecordAt(new DataView(original.buffer)) + 16,
    true,
  );
  const bytes = new Uint8Array(original.length + 22);
  bytes.set(original);
  const record = new DataView(bytes.buffer, original.length);
  record.setUint32(0, 0x06054b50, true);
  record.setUint16(8, count, true);
  record.setUint16(10, count, true);
  record.setUint32(12, original.length - directoryAt, true);
  record.setUint32(16, directoryAt, true);
  return new Blob([bytes]);
}

/** The namespace an extension list's own elements carry. */
const EXTENSION_NS = "http://example.com/extension";

/** A one-sheet workbook part holding `sections` after its sheet list. */
function workbookWithExtensionXml(sections: string): string {
  return `<workbook xmlns="${MAIN_NS}" xmlns:r="${RELATIONSHIP_NS}" xmlns:ext="${EXTENSION_NS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>${sections}</workbook>`;
}

/** A one-sheet workbook part, as raw XML. */
function workbookPartXml(): string {
  return `<workbook xmlns="${MAIN_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

/** The mirror of that for the shared string table: prefixed items, plain `sst`. */
function mixedPrefixSharedStringsXml(long: string): string {
  return `<sst xmlns="${MAIN_NS}" xmlns:x="${MAIN_NS}"><x:si><x:t>alpha</x:t></x:si><x:si><x:t>${long}</x:t></x:si><x:si><x:t>gamma</x:t></x:si></sst>`;
}

/**
 * A sheet long enough that inflating its part takes many stream chunks, so a
 * one-cell sheet read alongside it would settle first.
 */
const SLOW_SHEET_ROWS: CellInput[][] = Array.from(
  { length: 2000 },
  (_, index) => [`row ${index + 1}`],
);

/** `rows` rows that each fill the column cap, as a raw worksheet part. */
function wideSheetXml(rows: number): string {
  const cells = "<c/>".repeat(MAX_SHEET_COLUMNS);
  return sheetXml(
    Array.from(
      { length: rows },
      (_, index) => `<row r="${index + 1}">${cells}</row>`,
    ).join(""),
  );
}

describe("parseWorkbook", () => {
  test("reads every sheet in workbook order with its name", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          { name: "Budget", rows: [["alpha"]] },
          { name: "Notes", rows: [["beta"]] },
        ],
      }),
    );

    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual([
      "Budget",
      "Notes",
    ]);
    expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
    expect((await parsed.sheets[1]!.read()).rows).toEqual([["beta"]]);
  });

  test("skips hidden and very hidden sheets", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          { name: "Visible", rows: [["alpha"]] },
          { name: "Hidden", rows: [["beta"]], hidden: "hidden" },
          { name: "Buried", rows: [["gamma"]], hidden: "veryHidden" },
        ],
      }),
    );

    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(["Visible"]);
  });

  test("builds readers only for the sheets the switcher shows", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          ...Array.from({ length: MAX_WORKBOOK_SHEETS + 25 }, (_, index) => ({
            name: `Sheet ${index + 1}`,
            rows: [[`cell ${index + 1}`]],
          })),
          { name: "Hidden", rows: [["hidden"]], hidden: "hidden" },
        ],
      }),
    );

    expect(parsed.sheets.length).toBe(MAX_WORKBOOK_SHEETS);
    expect(parsed.sheetCount).toBe(MAX_WORKBOOK_SHEETS + 25);
    expect((await parsed.sheets[0]!.read()).rows).toEqual([["cell 1"]]);
  });

  test("reads the date mode only from the workbook's own properties", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1", rows: [[{ v: 44927, s: 0 }]] }],
        styles: [{ numFmtId: 14 }],
        parts: {
          // An extension list carries elements of any origin, which spell
          // whatever local name they like.
          "xl/workbook.xml": workbookWithExtensionXml(
            `<extLst><ext uri="${EXTENSION_NS}"><ext:workbookPr date1904="1"/></ext></extLst>`,
          ),
        },
      }),
    );

    // The 1904 epoch would put this serial 1462 days later.
    expect((await parsed.sheets[0]!.read()).rows).toEqual([["2023-01-01"]]);
  });

  test("ignores a sheet list inside an extension list", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1", rows: [["alpha"]] }],
        parts: {
          "xl/workbook.xml": `<workbook xmlns="${MAIN_NS}" xmlns:r="${RELATIONSHIP_NS}"><extLst><ext uri="${EXTENSION_NS}"><sheets><sheet name="Ghost" sheetId="1" r:id="rId1"/></sheets></ext></extLst></workbook>`,
        },
      }),
    );

    expect(parsed.sheets).toEqual([]);
    expect(parsed.sheetCount).toBe(0);
  });

  test("ignores number formats an extension list declares", async () => {
    const grid = await readOneSheet([[{ v: 44927, s: 0 }]], {
      parts: {
        "xl/styles.xml": `<styleSheet xmlns="${MAIN_NS}"><cellXfs count="1"><xf numFmtId="164" applyNumberFormat="1"/></cellXfs><extLst><ext uri="${EXTENSION_NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts></ext></extLst></styleSheet>`,
      },
    });

    // The style names a format the workbook itself declares nowhere, so the
    // cell keeps its number.
    expect(grid.rows).toEqual([["44927"]]);
  });

  test("counts sheet declarations without building them", async () => {
    const declarations = Array.from(
      { length: 20_000 },
      (_, index) =>
        `<sheet name="Sheet ${index + 1}" sheetId="${index + 1}" r:id="rId1"${
          index === 2 ? ' state="hidden"' : ""
        }/>`,
    ).join("");

    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet 1", rows: [["alpha"]] }],
        parts: {
          // The sections after the sheet list never reach the DOM, which an
          // element left open inside one of them is what proves.
          "xl/workbook.xml": `<workbook xmlns="${MAIN_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets>${declarations}</sheets><definedNames><definedName name="x"></definedNames></workbook>`,
        },
      }),
    );

    expect(parsed.sheets.length).toBe(MAX_WORKBOOK_SHEETS);
    expect(parsed.sheetCount).toBe(19_999);
    expect(parsed.sheets[0]!.name).toBe("Sheet 1");
    expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
  });

  test("reads only the relationships the workbook needs", async () => {
    const filler = Array.from(
      { length: 20_000 },
      (_, index) =>
        `<Relationship Id="rFiller${index}" Type="${RELATIONSHIP_NS}/theme" Target="theme/theme${index}.xml"/>`,
    ).join("");

    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1", rows: [[{ t: "s", v: 0 }]] }],
        sharedStrings: ["shared"],
        parts: {
          // The element left open after them never reaches the DOM, which is
          // what keeps the part from being parsed whole.
          "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">${filler}<Relationship Id="rId1" Type="${RELATIONSHIP_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${RELATIONSHIP_NS}/sharedStrings" Target="sharedStrings.xml"/><unread></Relationships>`,
        },
      }),
    );

    expect((await parsed.sheets[0]!.read()).rows).toEqual([["shared"]]);
  });

  test("keeps every sheet when they are all hidden", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          { name: "One", rows: [["alpha"]], hidden: "hidden" },
          { name: "Two", rows: [["beta"]], hidden: "veryHidden" },
        ],
      }),
    );

    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(["One", "Two"]);
  });

  test("leaves a sheet part unread until that sheet is asked for", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          { name: "Good", rows: [["alpha"]] },
          { name: "Broken", trailing: "<row><c><v>1</v>" },
        ],
      }),
    );

    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual([
      "Good",
      "Broken",
    ]);
    expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
    await expect(parsed.sheets[1]!.read()).rejects.toThrow("Malformed XML");
  });

  test("reads a sheet once however many times it is asked for", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({ sheets: [{ name: "Sheet1", rows: [["alpha"]] }] }),
    );
    const sheet = parsed.sheets[0]!;

    const first = sheet.read();
    const second = sheet.read();

    expect(second).toBe(first);
    expect((await second).rows).toEqual([["alpha"]]);
  });

  test("holds a sheet's grid while it is among the most recent reads", async () => {
    const parsed = await workbookOfSheets(MAX_CACHED_SHEETS + 2);
    const first = parsed.sheets[0]!.read();
    await first;
    for (let index = 1; index < MAX_CACHED_SHEETS; index += 1) {
      await parsed.sheets[index]!.read();
    }

    expect(parsed.sheets[0]!.read()).toBe(first);
  });

  test("reads a sheet again once newer reads crowd its grid out", async () => {
    const parsed = await workbookOfSheets(MAX_CACHED_SHEETS + 2);
    const first = parsed.sheets[0]!.read();
    const grid = await first;
    for (let index = 1; index <= MAX_CACHED_SHEETS; index += 1) {
      await parsed.sheets[index]!.read();
    }

    const again = parsed.sheets[0]!.read();

    expect(again).not.toBe(first);
    expect(await again).toEqual(grid);
  });

  test("shares a read still in flight that newer reads cannot evict", async () => {
    const parsed = await workbookOfSheets(MAX_CACHED_SHEETS + 2);
    const first = parsed.sheets[0]!.read();
    const newer = Array.from({ length: MAX_CACHED_SHEETS }, (_, offset) =>
      parsed.sheets[offset + 1]!.read(),
    );

    expect(parsed.sheets[0]!.read()).toBe(first);
    const [grid] = await Promise.all([first, ...newer]);
    expect(grid.rows).toEqual([["cell 1"]]);
  });

  test("reads queued sheets newest request first, one at a time", async () => {
    const parsed = await workbookOfSheets(5);
    const settled: number[] = [];

    const grids = await Promise.all(
      parsed.sheets.map((sheet, index) =>
        sheet.read().then((grid) => {
          settled.push(index);
          return grid;
        }),
      ),
    );

    // The first request runs on arrival and the rest wait; each turn takes the
    // newest of them, so the last tab clicked is served before the ones
    // abandoned on the way to it.
    expect(settled).toEqual([0, 4, 3, 2, 1]);
    expect(grids.map((grid) => grid.rows)).toEqual([
      [["cell 1"]],
      [["cell 2"]],
      [["cell 3"]],
      [["cell 4"]],
      [["cell 5"]],
    ]);
  });

  test("shares the promise of a sheet already waiting its turn", async () => {
    const parsed = await workbookOfSheets(3);
    const running = parsed.sheets[0]!.read();
    const queued = parsed.sheets[1]!.read();

    expect(parsed.sheets[1]!.read()).toBe(queued);
    expect((await queued).rows).toEqual([["cell 2"]]);
    expect((await running).rows).toEqual([["cell 1"]]);
  });

  test("serves a waiting sheet next when it is asked for again", async () => {
    const parsed = await workbookOfSheets(4);
    const settled: number[] = [];
    const record = (index: number): Promise<void> =>
      parsed.sheets[index]!.read().then(() => {
        settled.push(index);
      });

    const reads = [record(0), record(1), record(2)];
    // Sheet 1 waits behind the read already running, and sheet 2 is abandoned
    // on the way back to it, so returning to sheet 1 takes the next turn.
    const again = parsed.sheets[1]!.read();
    await Promise.all([...reads, again]);

    expect(settled).toEqual([0, 1, 2]);
  });

  test("leaves the waiting order alone when the running sheet is asked for again", async () => {
    const parsed = await workbookOfSheets(4);
    const settled: number[] = [];
    const record = (index: number): Promise<void> =>
      parsed.sheets[index]!.read().then(() => {
        settled.push(index);
      });

    const reads = [record(0), record(1), record(2)];
    const again = parsed.sheets[0]!.read();
    await Promise.all([...reads, again]);

    expect(settled).toEqual([0, 2, 1]);
  });

  test("settles a sheet queued behind a slower one only after it", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          { name: "Slow", rows: SLOW_SHEET_ROWS },
          { name: "Quick", rows: [["alpha"]] },
        ],
      }),
    );
    const settled: string[] = [];

    await Promise.all(
      parsed.sheets.map((sheet) =>
        sheet.read().then(() => {
          settled.push(sheet.name);
        }),
      ),
    );

    // Read together, the small part would finish inflating long before the
    // large one. Read in turn, the sheet asked for first settles first.
    expect(settled).toEqual(["Slow", "Quick"]);
  });

  test("runs the next queued sheet after a read rejects", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          { name: "Broken", trailing: "<row><c><v>1</v>" },
          { name: "Good", rows: [["alpha"]] },
        ],
      }),
    );

    const broken = parsed.sheets[0]!.read();
    const queued = parsed.sheets[1]!.read();

    await expect(broken).rejects.toThrow("Malformed XML");
    expect((await queued).rows).toEqual([["alpha"]]);
  });

  test("keeps a failed sheet read while its entry is cached", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Broken", trailing: "<row><c><v>1</v>" }],
      }),
    );
    const sheet = parsed.sheets[0]!;

    const first = sheet.read();
    await expect(first).rejects.toThrow("Malformed XML");

    expect(sheet.read()).toBe(first);
  });

  test("rejects the read of a sheet whose part is missing", async () => {
    const parts = prefixedWorkbookParts();
    delete parts["xl/worksheets/sheet1.xml"];

    const parsed = await parseWorkbook(await partsBlob(parts));

    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(["Data"]);
    await expect(parsed.sheets[0]!.read()).rejects.toThrow("Data");
  });

  test("resolves a relationship target that needs normalizing", async () => {
    for (const target of [
      "./worksheets/sheet1.xml",
      "../xl/worksheets/sheet1.xml",
      "/xl/worksheets/sheet1.xml",
    ]) {
      const parsed = await parseWorkbook(
        await workbookBlob({
          sheets: [{ name: "Sheet1", rows: [["alpha"]] }],
          parts: { "xl/_rels/workbook.xml.rels": relationshipsXml(target) },
        }),
      );

      expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
    }
  });

  test("resolves a relationship target that percent-encodes a space", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/_rels/workbook.xml.rels": relationshipsXml(
            "worksheets/sheet%201.xml",
          ),
          "xl/worksheets/sheet 1.xml": sheetXml(rowXml(1, "alpha")),
        },
      }),
    );

    expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
  });

  test("resolves the shared string table through its workbook relationship", async () => {
    for (const target of ["strings.xml", "/xl/strings.xml"]) {
      const parsed = await parseWorkbook(
        await workbookBlob({
          sheets: [{ name: "Sheet1", rows: [[{ t: "s", v: 0 }]] }],
          parts: {
            "xl/_rels/workbook.xml.rels": relationshipsXmlWith(
              `${RELATIONSHIP_NS}/sharedStrings`,
              target,
            ),
            "xl/strings.xml": oneSharedStringXml("noncanonical"),
          },
        }),
      );

      const grid = await parsed.sheets[0]!.read();

      expect(grid.rows).toEqual([["noncanonical"]]);
      expect(grid.truncated).toBe(false);
    }
  });

  test("resolves a shared string relationship typed in the strict namespace", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1", rows: [[{ t: "s", v: 0 }]] }],
        parts: {
          "xl/_rels/workbook.xml.rels": relationshipsXmlWith(
            `${STRICT_RELATIONSHIP_NS}/sharedStrings`,
            "strings.xml",
          ),
          "xl/strings.xml": oneSharedStringXml("strict"),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows).toEqual([["strict"]]);
    expect(grid.truncated).toBe(false);
  });

  test("reads the conventional shared string part when no relationship names one", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1", rows: [[{ t: "s", v: 0 }]] }],
        sharedStrings: ["alpha"],
        parts: {
          "xl/_rels/workbook.xml.rels": relationshipsXml(
            "worksheets/sheet1.xml",
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows).toEqual([["alpha"]]);
    expect(grid.truncated).toBe(false);
  });

  test("resolves the styles part through its workbook relationship", async () => {
    for (const type of [
      `${RELATIONSHIP_NS}/styles`,
      `${STRICT_RELATIONSHIP_NS}/styles`,
    ]) {
      const parsed = await parseWorkbook(
        await workbookBlob({
          sheets: [{ name: "Sheet1", rows: [[{ v: 44927, s: 1 }]] }],
          parts: {
            "xl/_rels/workbook.xml.rels": relationshipsXmlWith(
              type,
              "custom/styles.xml",
            ),
            "xl/custom/styles.xml": DATE_STYLES,
          },
        }),
      );

      expect((await parsed.sheets[0]!.read()).rows).toEqual([["2023-01-01"]]);
    }
  });

  test("reads the conventional styles part when no relationship names one", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1", rows: [[{ v: 44927, s: 0 }]] }],
        styles: [{ numFmtId: 14 }],
        parts: {
          "xl/_rels/workbook.xml.rels": relationshipsXml(
            "worksheets/sheet1.xml",
          ),
        },
      }),
    );

    expect((await parsed.sheets[0]!.read()).rows).toEqual([["2023-01-01"]]);
  });

  test("reads shared, inline, and rich-run strings", async () => {
    const grid = await readOneSheet(
      [[{ t: "s", v: 1 }, "inline", { t: "s", v: 0 }]],
      { sharedStrings: [{ runs: ["rich ", "run"] }, "shared"] },
    );

    expect(grid.rows).toEqual([["shared", "inline", "rich run"]]);
  });

  test("leaves the phonetic guide out of a shared string", async () => {
    const grid = await readOneSheet(
      [
        [
          { t: "s", v: 0 },
          { t: "s", v: 1 },
        ],
      ],
      { parts: { "xl/sharedStrings.xml": PHONETIC_SHARED_STRINGS } },
    );

    expect(grid.rows).toEqual([["漢字", "ab"]]);
  });

  test("leaves the phonetic guide out of an inline string", async () => {
    const grid = await readSheetSpec({
      name: "Sheet1",
      trailing:
        '<row r="1"><c r="A1" t="inlineStr"><is><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></is></c></row>',
    });

    expect(grid.rows).toEqual([["漢字"]]);
  });

  test("resolves shared strings for a sheet reaching further into the table", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          { name: "Near", rows: [[{ t: "s", v: 0 }]] },
          { name: "Far", rows: [[{ t: "s", v: 2 }]] },
        ],
        sharedStrings: ["alpha", "beta", "gamma"],
      }),
    );

    const near = await parsed.sheets[0]!.read();
    const far = await parsed.sheets[1]!.read();

    expect(near.rows).toEqual([["alpha"]]);
    expect(near.truncated).toBe(false);
    expect(far.rows).toEqual([["gamma"]]);
    expect(far.truncated).toBe(false);
  });

  test("reads the last item of a table whose extension list holds a foreign item", async () => {
    const items = ["alpha", "beta", "gamma"]
      .map((text) => `<si><t>${text}</t></si>`)
      .join("");
    const foreign =
      '<extLst><ext xmlns:x14="http://example.com/ext" uri="{X}"><x14:si><x14:t>noise</x14:t></x14:si></ext></extLst>';

    const grid = await readOneSheet(
      [
        [
          { t: "s", v: 0 },
          { t: "s", v: 2 },
        ],
      ],
      {
        sharedStrings: ["alpha", "beta", "gamma"],
        parts: {
          "xl/sharedStrings.xml": `<sst xmlns="${MAIN_NS}" count="3" uniqueCount="3">${items}${foreign}</sst>`,
        },
      },
    );

    expect(grid.rows).toEqual([["alpha", "gamma"]]);
    expect(grid.truncated).toBe(false);
  });

  test("keeps a self-closing item as an empty string", async () => {
    // The item after the self-closing one is unwanted, so a scan that runs
    // past `<si/>` pairs index 2 with `beta` rather than `gamma`.
    const grid = await readOneSheet(
      [
        [
          { t: "s", v: 0 },
          { t: "s", v: 2 },
        ],
      ],
      {
        sharedStrings: ["", "beta", "gamma"],
        parts: {
          "xl/sharedStrings.xml": `<sst xmlns="${MAIN_NS}" count="3" uniqueCount="3"><si/><si><t>beta</t></si><si><t>gamma</t></si></sst>`,
        },
      },
    );

    expect(grid.rows).toEqual([["", "gamma"]]);
  });

  test("leaves shared string markers inside a comment out of the string count", async () => {
    const grid = await readOneSheet([[{ t: "s", v: 1 }]], {
      parts: {
        "xl/sharedStrings.xml": `<sst xmlns="${MAIN_NS}" count="2" uniqueCount="2"><!--<si/><si/><si/>--><si><t>alpha</t></si><si><t>beta</t></si></sst>`,
      },
    });

    expect(grid.rows).toEqual([["beta"]]);
    expect(grid.truncated).toBe(false);
  });

  test("reads only the shared strings a sheet references", async () => {
    const filler = "<si><t>s</t></si>";
    const items = [
      "<si><t>first</t></si>",
      filler.repeat(149_999),
      "<si><t>middle</t></si>",
      filler.repeat(149_998),
      "<si><t>last</t></si>",
    ].join("");

    const grid = await readOneSheet(
      [
        [
          { t: "s", v: 0 },
          { t: "s", v: 150_000 },
          { t: "s", v: 299_999 },
        ],
      ],
      {
        parts: {
          "xl/sharedStrings.xml": `<sst xmlns="${MAIN_NS}">${items}</sst>`,
        },
      },
    );

    expect(grid.rows).toEqual([["first", "middle", "last"]]);
    expect(grid.truncated).toBe(false);
  });

  test("reads a shared string past many batches of the table", async () => {
    const items = [
      "<si><t>s</t></si>".repeat(199_999),
      "<si><t>last</t></si>",
    ].join("");

    const grid = await readOneSheet(
      [[{ t: "s", v: 199_999 }]],
      {
        parts: {
          "xl/sharedStrings.xml": `<sst xmlns="${MAIN_NS}">${items}</sst>`,
        },
      },
      { streamBatchChars: 64 * 1024 },
    );

    expect(grid.rows).toEqual([["last"]]);
    expect(grid.truncated).toBe(false);
  });

  test("settles a shared string read without parsing the items around it", async () => {
    const grid = await readOneSheet([[{ t: "s", v: 1 }]], {
      parts: {
        // Neither the item before the wanted one nor the one after it is well
        // formed, so this reads back only by keeping the one it is after.
        "xl/sharedStrings.xml": `<sst xmlns="${MAIN_NS}"><si><t>alpha<si><t>beta</t></si><si><t>gamma</sst>`,
      },
    });

    expect(grid.rows).toEqual([["beta"]]);
    expect(grid.truncated).toBe(false);
  });

  test("bounds the shared strings it keeps across sheets", async () => {
    const blob = await workbookBlob({
      sheets: [
        {
          name: "A",
          rows: [
            [
              { t: "s", v: 0 },
              { t: "s", v: 1 },
              { t: "s", v: 2 },
            ],
          ],
        },
        {
          name: "B",
          rows: [
            [
              { t: "s", v: 3 },
              { t: "s", v: 4 },
              { t: "s", v: 5 },
            ],
          ],
        },
        { name: "C", rows: [["c"]] },
        { name: "D", rows: [["d"]] },
      ],
      sharedStrings: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
    });

    /** Every sheet in turn, then the first one once its grid is evicted. */
    const readAround = async (
      options: ParseWorkbookOptions,
    ): Promise<{ reads: number; rows: string[][] }> => {
      const parsed = await parseWorkbook(blob, options);
      const lookups = spyOn(JSZip.prototype, "file");
      for (const sheet of parsed.sheets) {
        await sheet.read();
      }
      const again = await parsed.sheets[0]!.read();
      const reads = lookups.mock.calls.filter(
        (args) => args[0] === "xl/sharedStrings.xml",
      ).length;
      lookups.mockRestore();
      return { reads, rows: again.rows };
    };

    const bounded = await readAround({ maxCachedStrings: 4 });
    const whole = await readAround({});

    // The last read finds two of its three strings dropped and reads the
    // table again, where a workbook holding every string it has seen does not.
    expect(bounded.reads).toBe(3);
    expect(whole.reads).toBe(2);
    expect(bounded.rows).toEqual([["alpha", "beta", "gamma"]]);
    expect(whole.rows).toEqual(bounded.rows);
  });

  test("reads a shared-string cell with no index as blank", async () => {
    const grid = await readOneSheet([[{ t: "s" }, { t: "s", v: "" }]]);

    expect(grid.rows).toEqual([["", ""]]);
    expect(grid.truncated).toBe(false);
  });

  test("reads numbers, booleans, errors, and formula cells", async () => {
    const grid = await readOneSheet([
      [
        { v: 42 },
        { t: "b", v: "1" },
        { t: "b", v: "0" },
        { t: "e", v: "#N/A" },
      ],
      [
        { f: "SUM(A1:A2)", v: 7 },
        { f: "SUM(A1:A2)" },
        { v: "not a number" },
        null,
      ],
    ]);

    expect(grid.headers).toBeNull();
    expect(grid.rows).toEqual([
      ["42", "TRUE", "FALSE", "#N/A"],
      ["7", "=SUM(A1:A2)", "not a number", ""],
    ]);
  });

  test("reads an unevaluated formula whose cached value is empty", async () => {
    const grid = await readOneSheet([
      [{ f: "SUM(A1:A2)", v: "" }, { f: "SUM(A1:A2)", v: 3 }, { v: "" }],
    ]);

    expect(grid.rows).toEqual([["=SUM(A1:A2)", "3", ""]]);
  });

  test("reads a shared formula's follower as blank rather than a bare =", async () => {
    const grid = await readOneSheet([[{ f: "" }, { t: "str", f: "" }]]);

    expect(grid.rows).toEqual([["", ""]]);
  });

  test("shows a typed formula whose cached value is empty", async () => {
    const grid = await readOneSheet([
      [
        { t: "str", f: "A1&B1", v: "" },
        { t: "b", f: "A1>B1", v: "" },
        { t: "str", f: "A1&B1", v: "hello" },
        { t: "b", f: "A1>B1", v: "1" },
      ],
    ]);

    expect(grid.rows).toEqual([["=A1&B1", "=A1>B1", "hello", "TRUE"]]);
  });

  test("keeps the typed reading of an empty cell that has no formula", async () => {
    const grid = await readOneSheet([
      [{ t: "str", v: "" }, { t: "b", v: "" }, { t: "e", v: "" }, { v: "" }],
    ]);

    expect(grid.rows).toEqual([["", "FALSE", "", ""]]);
  });

  test("renders date-styled numbers from a built-in format id", async () => {
    const grid = await readOneSheet(
      [
        [
          { v: 44927, s: 0 },
          { v: 44927, s: 1 },
        ],
        [
          { v: 45000.5, s: 0 },
          { v: 1, s: 1 },
        ],
      ],
      { styles: [{ numFmtId: 14 }, { numFmtId: 0 }] },
    );

    expect(grid.rows).toEqual([
      ["2023-01-01", "44927"],
      ["2023-03-15", "1"],
    ]);
  });

  test("hides the clock of a date-only format", async () => {
    const grid = await readOneSheet(
      [[{ v: 44927.5, s: 0 }], [{ v: 44927.5, s: 1 }]],
      { styles: [{ numFmtId: 14 }, { numFmtId: 22 }] },
    );

    expect(grid.rows).toEqual([["2023-01-01"], ["2023-01-01 12:00"]]);
  });

  test("renders time-only and date-time number formats", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 0.5, s: 0 }],
        [{ v: 0.043090277777777776, s: 1 }],
        [{ v: 45000.5, s: 2 }],
        [{ v: 0.5, s: 3 }],
      ],
      {
        styles: [
          { numFmtId: 20 },
          { numFmtId: 21 },
          { numFmtId: 22 },
          { formatCode: "mm:ss" },
        ],
      },
    );

    // The last style spells a seconds field, so it reads to the second.
    expect(grid.rows).toEqual([
      ["12:00"],
      ["01:02:03"],
      ["2023-03-15 12:00"],
      ["12:00:00"],
    ]);
  });

  test("reads the East Asian built-in time ids as clock readings", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 0.5, s: 0 }],
        [{ v: 0.043090277777777776, s: 1 }],
        [{ v: 44927, s: 2 }],
        [{ v: 44927, s: 3 }],
      ],
      {
        // 32 and 33 spell a time of day inside the 27 to 36 date block, which
        // 31 and 34 stay on either side of.
        styles: [
          { numFmtId: 32 },
          { numFmtId: 33 },
          { numFmtId: 31 },
          { numFmtId: 34 },
        ],
      },
    );

    expect(grid.rows).toEqual([
      ["12:00"],
      ["01:02:03"],
      ["2023-01-01"],
      ["2023-01-01"],
    ]);
  });

  test("prints seconds only when the format spells them", async () => {
    // 12:00:01, which only a format spelling a seconds field shows.
    const pastNoon = 0.5000116;
    const grid = await readOneSheet(
      [
        [{ v: pastNoon, s: 0 }],
        [{ v: pastNoon, s: 1 }],
        [{ v: 45000 + pastNoon, s: 2 }],
        [{ v: 0.5, s: 1 }],
        [{ v: pastNoon, s: 3 }],
        [{ v: 0.5, s: 4 }],
      ],
      {
        styles: [
          { numFmtId: 18 },
          { numFmtId: 21 },
          { numFmtId: 22 },
          { formatCode: "h:mm" },
          { formatCode: "h:mm:ss" },
        ],
      },
    );

    expect(grid.rows).toEqual([
      ["12:00 PM"],
      ["12:00:01"],
      ["2023-03-15 12:00"],
      ["12:00:00"],
      ["12:00"],
      ["12:00:00"],
    ]);
  });

  test("counts an elapsed format past midnight instead of wrapping at it", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 2, s: 0 }],
        [{ v: 1.5, s: 0 }],
        [{ v: 0.5, s: 1 }],
        [{ v: 2, s: 1 }],
        [{ v: 0.5, s: 2 }],
      ],
      {
        styles: [
          { numFmtId: 46 },
          { formatCode: "[h]:mm" },
          { formatCode: "[mm]:ss" },
        ],
      },
    );

    expect(grid.rows).toEqual([
      ["48:00:00"],
      ["36:00:00"],
      ["12:00"],
      ["48:00"],
      ["720:00"],
    ]);
  });

  test("renders a 12-hour format code on a 12-hour clock", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 0.5, s: 0 }],
        [{ v: 0.5, s: 1 }],
        [{ v: 0.5, s: 2 }],
        [{ v: 0.5, s: 3 }],
      ],
      {
        styles: [
          { formatCode: "h:mm AM/PM" },
          { formatCode: "h:mm:ss AM/PM" },
          { formatCode: "[$-409]h:mm:ss AM/PM" },
          { formatCode: "h:mm A/P" },
        ],
      },
    );

    expect(grid.rows).toEqual([
      ["12:00 PM"],
      ["12:00:00 PM"],
      ["12:00:00 PM"],
      ["12:00 P"],
    ]);
  });

  test("closes a 12-hour format with its meridiem", async () => {
    const grid = await readOneSheet(
      [
        [
          { v: 0.75, s: 0 },
          { v: 0.75, s: 1 },
          { v: 0.75, s: 2 },
        ],
        [
          { v: 0, s: 0 },
          { v: 0, s: 1 },
          { v: 0, s: 2 },
        ],
        [
          { v: 0.5, s: 0 },
          { v: 0.5, s: 1 },
          { v: 0.5, s: 2 },
        ],
      ],
      {
        // 18 and 19 spell a meridiem, 20 is the same reading without one.
        styles: [{ numFmtId: 18 }, { numFmtId: 19 }, { numFmtId: 20 }],
      },
    );

    expect(grid.rows).toEqual([
      ["6:00 PM", "6:00:00 PM", "18:00"],
      ["12:00 AM", "12:00:00 AM", "00:00"],
      ["12:00 PM", "12:00:00 PM", "12:00"],
    ]);
  });

  test("spells a custom meridiem token the way the code does", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 0.75, s: 0 }],
        [{ v: 0.75, s: 1 }],
        [{ v: 0.75, s: 2 }],
        [{ v: 0.75, s: 3 }],
        [{ v: 0.75, s: 4 }],
      ],
      {
        styles: [
          { formatCode: "h:mm AM/PM" },
          { formatCode: "hh:mm A/P" },
          { formatCode: "h:mm:ss am/pm" },
          { formatCode: "[$-409]h:mm:ss AM/PM" },
          { formatCode: "m/d/yy h:mm AM/PM" },
        ],
      },
    );

    expect(grid.rows).toEqual([
      ["6:00 PM"],
      ["6:00 P"],
      ["6:00:00 PM"],
      ["6:00:00 PM"],
      ["1899-12-31 6:00 PM"],
    ]);
  });

  test("keeps the 1904 epoch on a 12-hour format", async () => {
    const grid = await readOneSheet(
      [[{ v: 0.75, s: 0 }], [{ v: 1462.75, s: 1 }]],
      {
        date1904: true,
        styles: [{ numFmtId: 18 }, { formatCode: "yyyy-mm-dd h:mm AM/PM" }],
      },
    );

    expect(grid.rows).toEqual([["6:00 PM"], ["1908-01-02 6:00 PM"]]);
  });

  test("renders date-styled numbers from a custom format code", async () => {
    const grid = await readOneSheet(
      [
        [
          { v: 44927, s: 0 },
          { v: 44927, s: 1 },
        ],
        [
          { v: 44927, s: 2 },
          { v: 44927, s: 3 },
        ],
      ],
      {
        styles: [
          { formatCode: "dd/mm/yyyy" },
          { formatCode: '"day" 0.00' },
          { formatCode: "[Red]0.00" },
          { formatCode: "0.00\\d" },
        ],
      },
    );

    expect(grid.rows).toEqual([
      ["2023-01-01", "44927"],
      ["44927", "44927"],
    ]);
  });

  test("classifies a custom format code by its first section", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 44927, s: 0 }],
        [{ v: 44927, s: 1 }],
        [{ v: 0.5, s: 2 }],
        [{ v: 44927, s: 3 }],
        [{ v: 0.5, s: 4 }],
      ],
      {
        // The sections after the first hold the negative, zero, and text
        // renderings, which a serial this reads as a date never takes.
        styles: [
          { formatCode: "0;0;yyyy-mm-dd" },
          { formatCode: "yyyy-mm-dd;@" },
          { formatCode: "[$-409]h:mm;@" },
          { formatCode: '"a;b"yyyy-mm-dd' },
          { formatCode: "0.00;[h]:mm" },
        ],
      },
    );

    expect(grid.rows).toEqual([
      ["44927"],
      ["2023-01-01"],
      ["12:00"],
      ["2023-01-01"],
      ["0.5"],
    ]);
  });

  test("selects the zero section of a custom format code", async () => {
    const grid = await readOneSheet(
      [[{ v: 0, s: 0 }], [{ v: 0.5, s: 0 }], [{ v: 0, s: 1 }]],
      {
        // Excel reads a zero value from the third section, which a code of
        // fewer sections leaves to the first.
        styles: [{ formatCode: "h:mm;h:mm;0" }, { formatCode: "h:mm;h:mm" }],
      },
    );

    expect(grid.rows).toEqual([["0"], ["12:00"], ["00:00"]]);
  });

  test("selects a custom format section by its condition", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 50, s: 0 }],
        [{ v: 44927, s: 0 }],
        [{ v: 5, s: 1 }],
        [{ v: 0, s: 2 }],
      ],
      {
        styles: [
          { formatCode: "[>=100]yyyy-mm-dd;0" },
          { formatCode: "[Red][<0]-0.00;0.00" },
          { formatCode: "[>0]h:mm;0" },
        ],
      },
    );

    expect(grid.rows).toEqual([["50"], ["2023-01-01"], ["5"], ["0"]]);
  });

  test("bounds the style table at Excel's cell format limit", async () => {
    const formats = Array.from(
      { length: MAX_CELL_FORMATS + 5 },
      (_, index) =>
        `<xf numFmtId="${index >= MAX_CELL_FORMATS - 1 ? 14 : 0}"/>`,
    ).join("");

    const grid = await readOneSheet(
      [
        [
          { v: 44927, s: MAX_CELL_FORMATS - 1 },
          { v: 44927, s: MAX_CELL_FORMATS + 4 },
        ],
      ],
      {
        parts: {
          // The blocks the reader has no use for never reach the DOM, which
          // an element left open inside one of them is what proves.
          "xl/styles.xml": `<styleSheet xmlns="${MAIN_NS}"><fonts count="1"><font><sz val="11"></fonts><numFmts count="0"/><cellXfs count="${
            MAX_CELL_FORMATS + 5
          }">${formats}</cellXfs></styleSheet>`,
        },
      },
    );

    // The style inside the cap renders its date, and the one past it falls
    // back to a plain number.
    expect(grid.rows).toEqual([["2023-01-01", "44927"]]);
  });

  test("keeps a number whose format spaces or fills with a date letter", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 44927, s: 0 }],
        [{ v: 44927, s: 1 }],
        [{ v: 44927, s: 2 }],
        [{ v: 44927, s: 3 }],
      ],
      {
        styles: [
          { formatCode: "0_m" },
          { formatCode: "0*d" },
          { formatCode: "#,##0_);(#,##0)" },
          { formatCode: "yyyy-mm-dd_)" },
        ],
      },
    );

    // `_` and `*` each carry the character after them, so the letter spells a
    // width or a fill rather than a date.
    expect(grid.rows).toEqual([
      ["44927"],
      ["44927"],
      ["44927"],
      ["2023-01-01"],
    ]);
  });

  test("ignores a numFmt a dxf declares under a real format's id", async () => {
    const grid = await readOneSheet([[{ v: 44927, s: 0 }]], {
      parts: { "xl/styles.xml": COLLIDING_DXF_STYLES },
    });

    expect(grid.rows).toEqual([["2023-01-01"]]);
  });

  test("renders a date-styled number outside the calendar as a number", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 1735689600000, s: 0 }],
        [{ v: 1e9, s: 0 }],
        [{ v: -5, s: 0 }],
        [{ v: 2958465, s: 0 }],
      ],
      { styles: [{ numFmtId: 14 }] },
    );

    expect(grid.rows).toEqual([
      ["1735689600000"],
      ["1000000000"],
      ["-5"],
      ["9999-12-31"],
    ]);
  });

  test("honours a 1904 workbook epoch", async () => {
    const grid = await readOneSheet([[{ v: 43465, s: 0 }], [{ v: 60, s: 0 }]], {
      styles: [{ numFmtId: 14 }],
      date1904: true,
    });

    expect(grid.rows).toEqual([["2023-01-01"], ["1904-03-01"]]);
  });

  test("keeps the 1900 workbook's phantom leap day apart from 28 February", async () => {
    const grid = await readOneSheet(
      [
        [{ v: 59, s: 0 }],
        [{ v: 60, s: 0 }],
        [{ v: 60.5, s: 1 }],
        [{ v: 61, s: 0 }],
      ],
      // The phantom day holds a clock reading too, which only a date and time
      // format shows.
      { styles: [{ numFmtId: 14 }, { numFmtId: 22 }] },
    );

    expect(grid.rows).toEqual([
      ["1900-02-28"],
      ["1900-02-29"],
      ["1900-02-29 12:00"],
      ["1900-03-01"],
    ]);
  });

  test("places cells without a reference in the next column", async () => {
    const grid = await readOneSheet([
      [
        { v: 1, noRef: true },
        { v: 2, noRef: true },
        { v: 3, noRef: true },
      ],
    ]);

    expect(grid.rows).toEqual([["1", "2", "3"]]);
  });

  test("leaves a gap where a row skips a column reference", async () => {
    const grid = await readOneSheet([[{ v: 1 }, null, { v: 3 }]]);

    expect(grid.rows).toEqual([["1", "", "3"]]);
  });

  test("keeps the position of a row the sheet omits for being blank", async () => {
    const grid = await readSheetSpec({
      name: "Sheet1",
      rows: [["alpha"]],
      trailing: rowXml(3, "gamma"),
    });

    expect(grid.rows).toEqual([["alpha"], [""], ["gamma"]]);
    expect(grid.truncated).toBe(false);
  });

  test("appends a row that carries no position after the previous one", async () => {
    const grid = await readSheetSpec({
      name: "Sheet1",
      rows: [["alpha"]],
      trailing: '<row><c t="inlineStr"><is><t>beta</t></is></c></row>',
    });

    expect(grid.rows).toEqual([["alpha"], ["beta"]]);
  });

  test("fills only up to the row cap for a row far past it", async () => {
    const grid = await readSheetSpec({
      name: "Sheet1",
      trailing: rowXml(MAX_CSV_ROWS + 10, "far"),
    });

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.rows.some((row) => row.some((cell) => cell !== ""))).toBe(
      false,
    );
    expect(grid.truncated).toBe(true);
  });

  test("stops at the row cap and says the sheet was cut", async () => {
    const rows: CellInput[][] = Array.from(
      { length: MAX_CSV_ROWS + 5 },
      (_, index) => [index],
    );

    const grid = await readOneSheet(rows);

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.rows[MAX_CSV_ROWS - 1]).toEqual([String(MAX_CSV_ROWS - 1)]);
    expect(grid.truncated).toBe(true);
  });

  test("keeps a sheet that fills the row cap and then declares row breaks", async () => {
    const rows: CellInput[][] = Array.from(
      { length: MAX_CSV_ROWS },
      (_, index) => [index],
    );

    const grid = await readSheetSpec({
      name: "Sheet1",
      rows,
      afterSheetData: ROW_BREAKS,
    });

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.truncated).toBe(false);
  });

  test("cuts a sheet past the row cap that also declares row breaks", async () => {
    const rows: CellInput[][] = Array.from(
      { length: MAX_CSV_ROWS + 1 },
      (_, index) => [index],
    );

    const grid = await readSheetSpec({
      name: "Sheet1",
      rows,
      afterSheetData: ROW_BREAKS,
    });

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.truncated).toBe(true);
  });

  test("clamps a wide sheet to the column cap and says so", async () => {
    const wide: CellInput[] = Array.from(
      { length: MAX_SHEET_COLUMNS + 3 },
      (_, index) => index,
    );

    const grid = await readOneSheet([wide, wide]);

    expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.truncated).toBe(true);
  });

  test("keeps a thousand columns of a row and cuts the rest", async () => {
    const wide: CellInput[] = Array.from(
      { length: 1_200 },
      (_, index) => index + 1,
    );

    const grid = await readOneSheet([wide]);

    expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.rows[0]![MAX_SHEET_COLUMNS - 1]).toBe(
      String(MAX_SHEET_COLUMNS),
    );
    expect(grid.truncated).toBe(true);
  });

  test("reads the extent the dimension record states", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/worksheets/sheet1.xml": dimensionSheetXml(
            "A1:KN20",
            rowXml(1, "alpha"),
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.extent).toEqual({ rows: 20, columns: 300 });
  });

  test("reads the extent from an absolute dimension ref", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/worksheets/sheet1.xml": dimensionSheetXml(
            "$A$1:$KN$20",
            rowXml(1, "alpha"),
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.extent).toEqual({ rows: 20, columns: 300 });
  });

  test("reads no extent from a one-cell dimension", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/worksheets/sheet1.xml": dimensionSheetXml(
            "A1",
            rowXml(1, "alpha"),
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.extent).toBeNull();
  });

  test("reads no extent from a range it cannot read", async () => {
    // An end cell with no row, no column, a row of zero, and a range with no
    // end at all: each one reads as no extent rather than as a range to
    // measure a cut against.
    for (const ref of ["A1:20", "A1:KN", "A1:KN0", "A1:", ""]) {
      const parsed = await parseWorkbook(
        await workbookBlob({
          sheets: [{ name: "Sheet1" }],
          parts: {
            "xl/worksheets/sheet1.xml": dimensionSheetXml(
              ref,
              rowXml(1, "alpha"),
            ),
          },
        }),
      );

      const grid = await parsed.sheets[0]!.read();

      expect(grid.extent).toBeNull();
    }
  });

  test("reads no extent from a sheet that states no dimension", async () => {
    const grid = await readOneSheet([["alpha"]]);

    expect(grid.extent).toBeNull();
  });

  test("keeps a sheet whose only cell sits past the column cap truncated", async () => {
    // One cell at `r="ALM1"`, which is column 1001, so the preview window
    // holds nothing and the grid has to say the sheet was cut.
    const sparse: CellInput[] = [
      ...Array.from({ length: MAX_SHEET_COLUMNS }, () => null),
      { v: 42 },
    ];

    const grid = await readOneSheet([sparse]);

    expect(grid.headers).toBeNull();
    expect(grid.rows).toEqual([[]]);
    expect(grid.truncated).toBe(true);
  });

  test("keeps the DOM clear of cells past the column cap", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          // The cell past the cap never closes, so a DOM built over it rejects
          // the part.
          "xl/worksheets/sheet1.xml": sheetXml(
            wideRowXml(1, MAX_SHEET_COLUMNS, UNCLOSED_CELL),
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.truncated).toBe(true);
  });

  test("drops cells past the cap from every row, not only the first", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/worksheets/sheet1.xml": sheetXml(
            `${wideRowXml(1, MAX_SHEET_COLUMNS, UNCLOSED_CELL)}${wideRowXml(
              2,
              MAX_SHEET_COLUMNS,
              UNCLOSED_CELL,
            )}${rowXml(3, "alpha")}`,
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows.length).toBe(3);
    expect(grid.rows[1]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.rows[2]![0]).toBe("alpha");
    expect(grid.truncated).toBe(true);
  });

  test("drops cells past the cap in a prefixed sheet", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/worksheets/sheet1.xml": prefixedSheetPartXml(
            prefixedWideRowXml(1, MAX_SHEET_COLUMNS, prefixedUnclosedCell()),
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.truncated).toBe(true);
  });

  test("leaves a commented-out cell out of the cell count", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/worksheets/sheet1.xml": sheetXml(
            `<row r="1"><c><v>1</v></c><!-- <c/></row> -->${"<c><v>1</v></c>".repeat(
              MAX_SHEET_COLUMNS - 1,
            )}</row>`,
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.truncated).toBe(false);
  });

  test("finds the row end outside CDATA, comments, and instructions", async () => {
    // Each of these sits among the cells past the cap, so the trim drops it
    // before a DOM is built. happy-dom reads no CDATA section and no
    // processing instruction, which a browser and a WKWebView both do.
    for (const hidden of [
      "<![CDATA[</row>]]>",
      "<!-- </row> -->",
      "<?sheet </row> ?>",
    ]) {
      const parsed = await parseWorkbook(
        await workbookBlob({
          sheets: [{ name: "Sheet1" }],
          parts: {
            "xl/worksheets/sheet1.xml": sheetXml(
              `${wideRowXml(
                1,
                MAX_SHEET_COLUMNS,
                `${rawInlineCellXml(hidden)}<c><v>2</v></c>`,
              )}${rowXml(2, "alpha")}`,
            ),
          },
        }),
      );

      const grid = await parsed.sheets[0]!.read();

      expect(grid.rows.length).toBe(2);
      expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
      expect(grid.rows[1]![0]).toBe("alpha");
      expect(grid.truncated).toBe(true);
    }
  });

  test("decides a header row the same way parseCsv does", async () => {
    const grid = await readOneSheet([
      ["name", "count"],
      ["alpha", "1"],
      ["beta", "2"],
    ]);

    expect(grid).toEqual({
      ...parseCsv("name,count\nalpha,1\nbeta,2\n"),
      extent: null,
    });
  });

  test("reads an empty sheet as no rows", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({ sheets: [{ name: "Sheet1" }] }),
    );

    expect(await parsed.sheets[0]!.read()).toEqual({
      headers: null,
      rows: [],
      truncated: false,
      extent: null,
    });
  });

  test("stops reading a sheet at the row cap", async () => {
    const rows: CellInput[][] = Array.from(
      { length: MAX_CSV_ROWS },
      (_, index) => [index],
    );
    // Broken XML past the cap: the sheet only parses if the reader stopped
    // before it, which is the guarantee the bounded read exists for.
    const blob = await workbookBlob({
      sheets: [{ name: "Sheet1", rows, trailing: '<row r="5001"><c><v>1</v>' }],
    });

    const parsed = await parseWorkbook(blob);
    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.truncated).toBe(true);
  });

  test("abandons a huge sheet once the row cap is met", async () => {
    const rows: CellInput[][] = Array.from({ length: 20_000 }, (_, index) => [
      `row ${index}`,
      index,
      { f: "SUM(A1:A2)", v: index * 2 },
    ]);
    const blob = await workbookBlob({ sheets: [{ name: "Big", rows }] });

    const parsed = await parseWorkbook(blob);
    const grid = await parsed.sheets[0]!.read();

    // A sheet several times the row cap keeps the cap and says it was cut,
    // whatever the rest of the part holds. The timeout is the stall guard.
    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.truncated).toBe(true);
  }, 60_000);

  test("cuts a sheet at the cell budget", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Wide" }],
        parts: { "xl/worksheets/sheet1.xml": wideSheetXml(400) },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    // The budget runs out inside a row, and that row is left out whole, so
    // what the grid holds is the budget to the cell.
    expect(grid.rows.length).toBe(MAX_SHEET_CELLS / MAX_SHEET_COLUMNS);
    expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.truncated).toBe(true);
  });

  test("cuts a first row that runs past the cell budget", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Wide" }],
        parts: {
          // The budget runs out inside the first row, and everything after
          // that cell is spelled so that keeping any of it reads back broken.
          "xl/worksheets/sheet1.xml": sheetXml(
            `<row r="1">${"<c/>".repeat(MAX_SHEET_CELLS)}<c><v>1</v><row r="2"><c/>`,
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows.length).toBe(1);
    expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.truncated).toBe(true);
  }, 60_000);

  test("keeps a sheet under the cell budget whole", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Wide" }],
        parts: { "xl/worksheets/sheet1.xml": wideSheetXml(200) },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows.length).toBe(200);
    expect(grid.rows[0]!.length).toBe(MAX_SHEET_COLUMNS);
    expect(grid.truncated).toBe(false);
  });

  test("drops a row that runs past the character cap and says so", async () => {
    const grid = await readOneSheet(
      [["alpha"], ["x".repeat(50_000)]],
      {},
      { maxPartChars: 2_000 },
    );

    expect(grid.rows).toEqual([["alpha"]]);
    expect(grid.truncated).toBe(true);
  });

  test("rejects a sheet whose first row runs past the character cap", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1", rows: [["x".repeat(50_000)]] }],
      }),
      { maxPartChars: 2_000 },
    );

    await expect(parsed.sheets[0]!.read()).rejects.toThrow(
      "xl/worksheets/sheet1.xml",
    );
  });

  test("blanks shared strings past the character cap and says so", async () => {
    const grid = await readOneSheet(
      [
        [
          { t: "s", v: 0 },
          { t: "s", v: 1 },
          { t: "s", v: 2 },
        ],
      ],
      { sharedStrings: ["alpha", "x".repeat(50_000), "gamma"] },
      { maxPartChars: 2_000 },
    );

    expect(grid.rows).toEqual([["alpha", "", ""]]);
    expect(grid.truncated).toBe(true);
  });

  test("rejects a style table that runs past the character cap", async () => {
    const blob = await workbookBlob({
      sheets: [{ name: "Sheet1", rows: [[{ v: 44927, s: 0 }]] }],
      styles: [{ formatCode: LONG_DATE_FORMAT }],
    });

    await expect(parseWorkbook(blob, { maxPartChars: 2_000 })).rejects.toThrow(
      "xl/styles.xml",
    );
  });

  test("rejects a workbook part that runs past the character cap", async () => {
    const blob = await workbookBlob({
      sheets: [{ name: "x".repeat(50_000), rows: [["alpha"]] }],
    });

    await expect(parseWorkbook(blob, { maxPartChars: 2_000 })).rejects.toThrow(
      "xl/workbook.xml",
    );
  });

  test("reads that same style table whole under the default character cap", async () => {
    const blob = await workbookBlob({
      sheets: [{ name: "Sheet1", rows: [[{ v: 44927, s: 0 }]] }],
      styles: [{ formatCode: LONG_DATE_FORMAT }],
    });

    const parsed = await parseWorkbook(blob);

    expect((await parsed.sheets[0]!.read()).rows).toEqual([["2023-01-01"]]);
  });

  test("reads the same sheet whole under the default character cap", async () => {
    const long = "x".repeat(50_000);

    const grid = await readOneSheet([["alpha"], [long]]);

    expect(grid.rows).toEqual([["alpha"], [long]]);
    expect(grid.truncated).toBe(false);
  });

  test("reads a workbook whose parts carry a namespace prefix", async () => {
    const prefixed = await parseWorkbook(
      await partsBlob(prefixedWorkbookParts()),
    );

    const grid = await prefixed.sheets[0]!.read();

    expect(prefixed.sheets.map((sheet) => sheet.name)).toEqual(["Data"]);
    expect(grid.rows).toEqual([
      ["shared", "inline", "2023-01-01", "=SUM(A1:A2)"],
    ]);
    expect(grid).toEqual(
      await readOneSheet([PREFIX_FIXTURE_ROW], {
        sharedStrings: ["shared"],
        styles: [{ numFmtId: 14 }],
      }),
    );
  });

  test("cuts a prefixed sheet at the row cap", async () => {
    const parts = prefixedWorkbookParts();
    parts["xl/worksheets/sheet1.xml"] = prefixedSheetXml(MAX_CSV_ROWS + 1);

    const parsed = await parseWorkbook(await partsBlob(parts));
    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.rows[MAX_CSV_ROWS - 1]).toEqual([`row ${MAX_CSV_ROWS - 1}`]);
    expect(grid.truncated).toBe(true);
  });

  test("counts rows spelled with a non-ASCII prefix", async () => {
    const parts = prefixedWorkbookParts();
    parts["xl/worksheets/sheet1.xml"] = prefixedSheetXml(200, "λ");

    const parsed = await parseWorkbook(await partsBlob(parts), {
      maxPartChars: 2_000,
    });

    // happy-dom parses no prefix outside ASCII, which a browser and a
    // WKWebView both do, so what the scan made of the part is read from how it
    // ends: a part cut at its last row is handed to the DOM and rejected
    // there, where a scan that counted no row at all rejects the part as
    // unreadable before any DOM is built.
    await expect(parsed.sheets[0]!.read()).rejects.toThrow("Malformed XML");
  });

  test("closes a cut sheet with the tags its own part opened", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/worksheets/sheet1.xml": mixedPrefixSheetXml(MAX_CSV_ROWS + 1),
        },
      }),
    );
    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.rows[MAX_CSV_ROWS - 1]).toEqual([`row ${MAX_CSV_ROWS - 1}`]);
    expect(grid.truncated).toBe(true);
  });

  test("leaves row markers inside a comment out of the row count", async () => {
    // A comment rather than CDATA, which happy-dom parses no more than it
    // parses a processing instruction.
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: {
          "xl/worksheets/sheet1.xml": sheetXml(
            `${rowXml(1, "alpha")}${rowMarkerComment(
              MAX_CSV_ROWS + 1_000,
            )}${rowXml(2, "beta")}${rowXml(3, "gamma")}`,
          ),
        },
      }),
    );

    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows).toEqual([["alpha"], ["beta"], ["gamma"]]);
    expect(grid.truncated).toBe(false);
  });

  test("keeps a comment that straddles a chunk boundary", async () => {
    const markers = 3;
    const opener = `<!--${"<row/>".repeat(markers)}`;
    for (const commentAt of [
      STREAM_BATCH_CHARS - 2,
      STREAM_BATCH_CHARS - 1 - opener.length,
    ]) {
      const xml = straddledCommentSheetXml(commentAt, markers);
      expect(xml.indexOf(opener)).toBe(commentAt);

      const parsed = await parseWorkbook(
        await workbookBlob({
          sheets: [{ name: "Sheet1" }],
          parts: { "xl/worksheets/sheet1.xml": xml },
        }),
        { streamBatchChars: STREAM_BATCH_CHARS },
      );
      const grid = await parsed.sheets[0]!.read();

      expect(grid.rows).toEqual([["alpha"], ["beta"]]);
      expect(grid.truncated).toBe(false);
    }
  });

  test("keeps an ancestor whose start tag straddles a chunk boundary", async () => {
    const xml = straddledAncestorSheetXml(400);
    expect(xml.indexOf("<y:sheetData>")).toBe(
      STREAM_BATCH_CHARS - ANCESTOR_STRADDLE_CHARS,
    );

    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [{ name: "Sheet1" }],
        parts: { "xl/worksheets/sheet1.xml": xml },
      }),
      {
        maxPartChars: STREAM_BATCH_CHARS + 1_000,
        streamBatchChars: STREAM_BATCH_CHARS,
      },
    );
    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows[0]).toEqual(["row 0"]);
    expect(grid.rows[grid.rows.length - 1]).toEqual([
      `row ${grid.rows.length - 1}`,
    ]);
    expect(grid.truncated).toBe(true);
  });

  test("closes a cut shared string table with the tag its own part opened", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({
        sheets: [
          {
            name: "Sheet1",
            rows: [
              [
                { t: "s", v: 0 },
                { t: "s", v: 1 },
                { t: "s", v: 2 },
              ],
            ],
          },
        ],
        parts: {
          "xl/sharedStrings.xml": mixedPrefixSharedStringsXml(
            "x".repeat(50_000),
          ),
        },
      }),
      { maxPartChars: 2_000 },
    );
    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows).toEqual([["alpha", "", ""]]);
    expect(grid.truncated).toBe(true);
  });

  test("bounds a prefixed shared string table at the character cap", async () => {
    const parts = prefixedWorkbookParts();
    parts["xl/sharedStrings.xml"] =
      `<x:sst xmlns:x="${MAIN_NS}"><x:si><x:t>alpha</x:t></x:si><x:si><x:t>${"x".repeat(50_000)}</x:t></x:si><x:si><x:t>gamma</x:t></x:si></x:sst>`;
    parts["xl/worksheets/sheet1.xml"] =
      `<x:worksheet xmlns:x="${MAIN_NS}"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="s"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>`;

    const parsed = await parseWorkbook(await partsBlob(parts), {
      maxPartChars: 2_000,
    });
    const grid = await parsed.sheets[0]!.read();

    expect(grid.rows).toEqual([["alpha", "", ""]]);
    expect(grid.truncated).toBe(true);
  });

  test("resolves the workbook part through the package relationship", async () => {
    for (const type of [
      `${RELATIONSHIP_NS}/officeDocument`,
      `${STRICT_RELATIONSHIP_NS}/officeDocument`,
    ]) {
      const parsed = await parseWorkbook(
        await partsBlob({
          "_rels/.rels": `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"><Relationship Id="rId1" Type="${type}" Target="book/wb.xml"/></Relationships>`,
          "book/wb.xml": workbookPartXml(),
          "book/_rels/wb.xml.rels": `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/worksheet" Target="sheets/s1.xml"/><Relationship Id="rId2" Type="${RELATIONSHIP_NS}/sharedStrings" Target="sst.xml"/></Relationships>`,
          "book/sheets/s1.xml": sheetXml(
            '<row r="1"><c r="A1" t="s"><v>0</v></c></row>',
          ),
          "book/sst.xml": oneSharedStringXml("shared"),
        }),
      );

      expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(["Data"]);
      expect((await parsed.sheets[0]!.read()).rows).toEqual([["shared"]]);
    }
  });

  test("reads the conventional workbook part when the package names none", async () => {
    const parsed = await parseWorkbook(
      await partsBlob({
        "xl/workbook.xml": workbookPartXml(),
        "xl/_rels/workbook.xml.rels": relationshipsXml("worksheets/sheet1.xml"),
        "xl/worksheets/sheet1.xml": sheetXml(rowXml(1, "alpha")),
      }),
    );

    expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
  });

  test("rejects a container with more entries than the preview reads", async () => {
    const parts = flatPackageParts();

    await expect(
      parseWorkbook(await partsBlob(parts), { maxZipEntries: 4 }),
    ).rejects.toThrow("zip entries");

    const parsed = await parseWorkbook(await partsBlob(parts), {
      maxZipEntries: 5,
    });

    expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
  });

  test("counts the entries the reader reaches, not the count a record declares", async () => {
    const crafted = await withTrailingRecord(
      await partsBlob(flatPackageParts()),
      1,
    );

    // The record the reader takes declares one entry and names the directory
    // holding all five, which is what it reads.
    await expect(parseWorkbook(crafted, { maxZipEntries: 4 })).rejects.toThrow(
      "zip entries",
    );

    const parsed = await parseWorkbook(crafted, { maxZipEntries: 5 });

    expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
  });

  test("leaves a container whose last record names no directory to the reader", async () => {
    const blob = await partsBlob(
      flatPackageParts(),
      `PK\u0005\u0006${"\u0000".repeat(18)}trailing`,
    );

    // The record inside the comment names a directory that holds nothing, so
    // the count the preview reads is zero and the reader has the last word:
    // it opens a container of no entries, which carries no workbook.
    await expect(parseWorkbook(blob)).rejects.toThrow(
      "xl/workbook.xml is missing",
    );
  });

  test("reads the entry count through a trailing zip comment", async () => {
    const blob = await partsBlob(
      {
        "xl/workbook.xml": workbookPartXml(),
        "xl/_rels/workbook.xml.rels": relationshipsXml("worksheets/sheet1.xml"),
        "xl/worksheets/sheet1.xml": sheetXml(rowXml(1, "alpha")),
      },
      "c".repeat(300),
    );

    // The count sits in front of the comment, so it is read only by scanning
    // back past it.
    await expect(parseWorkbook(blob, { maxZipEntries: 1 })).rejects.toThrow(
      "zip entries",
    );

    const parsed = await parseWorkbook(blob);

    expect((await parsed.sheets[0]!.read()).rows).toEqual([["alpha"]]);
  });

  test("rejects a blob that is not a zip", async () => {
    await expect(
      parseWorkbook(new Blob(["this is not a workbook"])),
    ).rejects.toThrow();
  });

  test("rejects a zip with no workbook part", async () => {
    await expect(
      parseWorkbook(await partsBlob({ "docProps/app.xml": "<Properties/>" })),
    ).rejects.toThrow("xl/workbook.xml");
  });
});
