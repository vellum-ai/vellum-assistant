import { describe, expect, test } from "bun:test";

import { layoutToolParams } from "@/domains/chat/utils/tool-param-layout";
import { toToolParams } from "@/domains/chat/utils/tool-params";

const layout = (input: Record<string, unknown>) =>
  layoutToolParams(toToolParams(input));

describe("layoutToolParams", () => {
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
