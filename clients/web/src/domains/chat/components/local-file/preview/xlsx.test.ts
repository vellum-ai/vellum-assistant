import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  parseCsv,
  type ParsedCsv,
} from "@/domains/chat/components/local-file/preview/csv";
import {
  parseWorkbook,
  type ParseWorkbookOptions,
} from "@/domains/chat/components/local-file/preview/xlsx";
import {
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
): Promise<ParsedCsv> {
  const parsed = await parseWorkbook(
    await workbookBlob({ sheets: [{ name: "Sheet1", rows }], ...extras }),
    options,
  );
  return parsed.sheets[0]!.read();
}

/** The one sheet of a workbook, for a sheet that states its own raw XML. */
async function readSheetSpec(sheet: SheetSpec): Promise<ParsedCsv> {
  const parsed = await parseWorkbook(await workbookBlob({ sheets: [sheet] }));
  return parsed.sheets[0]!.read();
}

/** A container holding exactly these parts, for a workbook the helper cannot state. */
async function zipBlob(parts: Record<string, string>): Promise<Blob> {
  const zip = new JSZip();
  for (const [path, xml] of Object.entries(parts)) {
    zip.file(path, xml);
  }
  const buffer = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
  return new Blob([buffer]);
}

/** A date format code long enough to push `xl/styles.xml` past a small cap. */
const LONG_DATE_FORMAT = `yyyy-mm-dd${"0".repeat(50_000)}`;

/** A row at `position` holding one inline string, as raw worksheet XML. */
function rowXml(position: number, text: string): string {
  return `<row r="${position}"><c r="A${position}" t="inlineStr"><is><t>${text}</t></is></c></row>`;
}

/** The section a worksheet writes after its rows, whose name starts with `row`. */
const ROW_BREAKS =
  '<rowBreaks count="1" manualBreakCount="1"><brk id="10" max="16383" man="1"/></rowBreaks>';

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";

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

  test("rejects the read of a sheet whose part is missing", async () => {
    const parts = prefixedWorkbookParts();
    delete parts["xl/worksheets/sheet1.xml"];

    const parsed = await parseWorkbook(await zipBlob(parts));

    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(["Data"]);
    await expect(parsed.sheets[0]!.read()).rejects.toThrow("Data");
  });

  test("reads shared, inline, and rich-run strings", async () => {
    const grid = await readOneSheet(
      [[{ t: "s", v: 1 }, "inline", { t: "s", v: 0 }]],
      { sharedStrings: [{ runs: ["rich ", "run"] }, "shared"] },
    );

    expect(grid.rows).toEqual([["shared", "inline", "rich run"]]);
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
      ["2023-03-15 12:00", "1"],
    ]);
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
        [{ v: 60.5, s: 0 }],
        [{ v: 61, s: 0 }],
      ],
      { styles: [{ numFmtId: 14 }] },
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
      trailing: ROW_BREAKS,
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
      trailing: ROW_BREAKS,
    });

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.truncated).toBe(true);
  });

  test("clamps a wide sheet to the column cap and says so", async () => {
    const wide: CellInput[] = Array.from(
      { length: MAX_CSV_COLUMNS + 3 },
      (_, index) => index,
    );

    const grid = await readOneSheet([wide, wide]);

    expect(grid.rows[0]!.length).toBe(MAX_CSV_COLUMNS);
    expect(grid.truncated).toBe(true);
  });

  test("decides a header row the same way parseCsv does", async () => {
    const grid = await readOneSheet([
      ["name", "count"],
      ["alpha", "1"],
      ["beta", "2"],
    ]);

    expect(grid).toEqual(parseCsv("name,count\nalpha,1\nbeta,2\n"));
  });

  test("reads an empty sheet as no rows", async () => {
    const parsed = await parseWorkbook(
      await workbookBlob({ sheets: [{ name: "Sheet1" }] }),
    );

    expect(await parsed.sheets[0]!.read()).toEqual({
      headers: null,
      rows: [],
      truncated: false,
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

    const startedAt = performance.now();
    const parsed = await parseWorkbook(blob);
    const grid = await parsed.sheets[0]!.read();
    const elapsed = performance.now() - startedAt;

    expect(grid.rows.length).toBe(MAX_CSV_ROWS);
    expect(grid.truncated).toBe(true);
    expect(elapsed).toBeLessThan(1000);
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
      await zipBlob(prefixedWorkbookParts()),
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

  test("rejects a blob that is not a zip", async () => {
    await expect(
      parseWorkbook(new Blob(["this is not a workbook"])),
    ).rejects.toThrow();
  });

  test("rejects a zip with no workbook part", async () => {
    const zip = new JSZip();
    zip.file("docProps/app.xml", "<Properties/>");
    const buffer = await zip.generateAsync({ type: "arraybuffer" });

    await expect(parseWorkbook(new Blob([buffer]))).rejects.toThrow(
      "xl/workbook.xml",
    );
  });
});
