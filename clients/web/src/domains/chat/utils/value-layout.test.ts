import { describe, expect, test } from "bun:test";

import {
  layoutValues as layout,
  type ValueField,
} from "@/domains/chat/utils/value-layout";

/** The first field `values` lays out to, for a test about one value. */
function firstField(values: Record<string, unknown>): ValueField | undefined {
  return layout(values).fields[0];
}

describe("layoutValues", () => {
  test("shows short values as text and long text as a code block", () => {
    const query = "x".repeat(81);
    expect(layout({ depth: "deep", max_results: 10, query })).toEqual({
      fields: [
        { kind: "text", label: "depth", text: "deep" },
        { kind: "text", label: "max_results", text: "10" },
        { kind: "code", label: "query", text: query },
      ],
      more: 0,
    });
  });

  test("writes a short list on one line and nests a long one by position", () => {
    const long = "a sentence far too long to read comfortably in a list";
    expect(
      layout({ sources: ["memory", "documents"], notes: ["short", long] }),
    ).toEqual({
      fields: [
        { kind: "list", label: "sources", items: ["memory", "documents"] },
        {
          kind: "nested",
          label: "notes",
          fields: {
            fields: [
              { kind: "text", label: "1", text: "short" },
              { kind: "text", label: "2", text: long },
            ],
            more: 0,
          },
        },
      ],
      more: 0,
    });
  });

  test("writes a small object on one line and nests a larger one", () => {
    expect(
      layout({
        record: {
          stage: "qualified",
          owner: { team: "growth" },
          tags: ["inbound", "trial"],
        },
      }),
    ).toEqual({
      fields: [
        {
          kind: "nested",
          label: "record",
          fields: {
            fields: [
              { kind: "text", label: "stage", text: "qualified" },
              {
                kind: "pairs",
                label: "owner",
                pairs: [{ key: "team", text: "growth" }],
              },
              { kind: "list", label: "tags", items: ["inbound", "trial"] },
            ],
            more: 0,
          },
        },
      ],
      more: 0,
    });
  });

  test("writes literals, empty strings, empty lists and empty objects visibly", () => {
    expect(
      layout({
        title: "",
        indent: "  ",
        public: false,
        cursor: null,
        tags: [],
        options: {},
      }).fields,
    ).toEqual([
      { kind: "text", label: "title", text: '""' },
      { kind: "text", label: "indent", text: '"  "' },
      { kind: "text", label: "public", text: "false" },
      { kind: "text", label: "cursor", text: "null" },
      { kind: "text", label: "tags", text: "[]" },
      { kind: "text", label: "options", text: "{}" },
    ]);
  });

  test("shows structure nested past the depth limit as JSON", () => {
    const wide = (inner: unknown) => ({
      a: "x".repeat(40),
      b: "y".repeat(40),
      inner,
    });
    let field: ValueField | undefined = layout({
      top: wide(wide(wide(wide({ f: 1 })))),
    }).fields[0];
    for (let depth = 0; depth < 4; depth += 1) {
      expect(field?.kind).toBe("nested");
      field =
        field?.kind === "nested"
          ? field.fields.fields.find((child) => child.label === "inner")
          : undefined;
    }
    expect(field).toEqual({
      kind: "code",
      label: "inner",
      text: JSON.stringify({ f: 1 }, null, 2),
    });
  });

  test("counts what is past the first twenty children", () => {
    const ids = Array.from({ length: 23 }, (_, index) => `id-${index + 1}`);
    const [field] = layout({ ids }).fields;
    expect(field).toMatchObject({ kind: "nested", label: "ids" });
    if (field?.kind === "nested") {
      expect(field.fields.fields).toHaveLength(20);
      expect(field.fields.more).toBe(3);
    }

    const wide = Object.fromEntries(
      Array.from({ length: 22 }, (_, index) => [`field_${index + 1}`, index]),
    );
    expect(layout(wide).more).toBe(2);
  });
});

describe("layoutValues tables", () => {
  test("lays out a list of records as a table, columns in first-seen order", () => {
    expect(
      firstField({
        contacts: [
          { email: "ada@example.com", stage: "qualified" },
          { stage: "trial", email: "grace@example.com", owner: "growth" },
        ],
      }),
    ).toEqual({
      kind: "table",
      label: "contacts",
      columns: ["email", "stage", "owner"],
      rows: [
        ["ada@example.com", "qualified", ""],
        ["grace@example.com", "trial", "growth"],
      ],
      more: 0,
    });
  });

  test("a key present in fewer than half the records breaks the table", () => {
    const records = [{ id: 1, note: "only here" }, { id: 2 }, { id: 3 }];
    expect(firstField({ records })).toMatchObject({
      kind: "nested",
      label: "records",
    });
    // The same key in half the records is still a table.
    expect(firstField({ records: records.slice(0, 2) })).toMatchObject({
      kind: "table",
      columns: ["id", "note"],
    });
  });

  test("a single record is not a table", () => {
    expect(firstField({ rows: [{ id: 1, name: "one" }] })).toMatchObject({
      kind: "nested",
      label: "rows",
    });
  });

  test("records wider than twelve keys nest instead", () => {
    const wide = (id: number) =>
      Object.fromEntries(
        Array.from({ length: 13 }, (_, index) => [`c${index}`, id]),
      );
    expect(firstField({ rows: [wide(1), wide(2)] })).toMatchObject({
      kind: "nested",
    });
    const twelve = (id: number) =>
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`c${index}`, id]),
      );
    expect(firstField({ rows: [twelve(1), twelve(2)] })).toMatchObject({
      kind: "table",
    });
  });

  test("a list holding anything but plain objects is not a table", () => {
    expect(firstField({ rows: [{ id: 1 }, null] })).toMatchObject({
      kind: "nested",
    });
    expect(firstField({ rows: [{ id: 1 }, [1]] })).toMatchObject({
      kind: "nested",
    });
  });

  test("writes null, blank and nested cells out rather than hiding them", () => {
    expect(
      firstField({
        rows: [
          { id: 1, owner: null, tags: ["a", "b"], meta: { deep: true } },
          { id: 2, owner: "", tags: [], meta: {} },
        ],
      }),
    ).toMatchObject({
      kind: "table",
      rows: [
        ["1", "null", '["a","b"]', '{"deep":true}'],
        ["2", '""', "[]", "{}"],
      ],
    });
  });

  test("recognises a columns and rows record, and only that spelling", () => {
    expect(
      firstField({
        result: {
          columns: ["week", "users"],
          rows: [["2026-08-03", 12840], ["2026-08-10"]],
        },
      }),
    ).toEqual({
      kind: "table",
      label: "result",
      columns: ["week", "users"],
      rows: [
        ["2026-08-03", "12840"],
        ["2026-08-10", ""],
      ],
      more: 0,
    });

    expect(
      firstField({
        result: { columns: [{ name: "week" }], rows: [["2026-08-03"]] },
      }),
    ).toMatchObject({ kind: "nested" });
    expect(
      firstField({
        result: { columns: ["week"], rows: [["2026-08-03"]], total: 1 },
      }),
    ).toMatchObject({ kind: "nested" });
    expect(
      firstField({
        result: { columns: ["week"], rows: [["2026-08-03", 12840]] },
      }),
    ).toMatchObject({ kind: "nested" });
    expect(
      firstField({ result: { columns: ["week"], rows: [] } }),
    ).toMatchObject({ kind: "nested" });
  });

  test("counts the rows past the first hundred", () => {
    const rows = Array.from({ length: 103 }, (_, index) => ({
      id: index + 1,
      name: `row ${index + 1}`,
    }));
    const field = firstField({ rows });
    expect(field).toMatchObject({ kind: "table", more: 3 });
    if (field?.kind === "table") {
      expect(field.rows).toHaveLength(100);
      expect(field.rows[99]).toEqual(["100", "row 100"]);
    }
  });
});
