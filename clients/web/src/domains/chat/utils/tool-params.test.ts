import { describe, expect, test } from "bun:test";

import { toolCallParams, toToolParams } from "@/domains/chat/utils/tool-params";

describe("toToolParams", () => {
  test("types each value by how it is shown", () => {
    expect(
      toToolParams({
        query: "select 1",
        max_results: 20,
        case_insensitive: false,
        cursor: null,
        sources: ["memory", 3],
        filter: { glob: "*.ts" },
      }),
    ).toEqual([
      { key: "query", value: { kind: "text", text: "select 1" } },
      { key: "max_results", value: { kind: "literal", text: "20" } },
      { key: "case_insensitive", value: { kind: "literal", text: "false" } },
      { key: "cursor", value: { kind: "literal", text: "null" } },
      {
        key: "sources",
        value: {
          kind: "list",
          items: [
            { kind: "text", text: "memory" },
            { kind: "literal", text: "3" },
          ],
        },
      },
      {
        key: "filter",
        value: {
          kind: "object",
          entries: [{ key: "glob", value: { kind: "text", text: "*.ts" } }],
        },
      },
    ]);
  });

  test("writes an empty list or object as-is", () => {
    expect(toToolParams({ tags: [], options: {} })).toEqual([
      { key: "tags", value: { kind: "literal", text: "[]" } },
      { key: "options", value: { kind: "literal", text: "{}" } },
    ]);
  });

  test("shows a subtree nested past the depth limit as JSON", () => {
    expect(toToolParams({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toEqual([
      {
        key: "a",
        value: {
          kind: "object",
          entries: [
            {
              key: "b",
              value: {
                kind: "object",
                entries: [
                  {
                    key: "c",
                    value: {
                      kind: "object",
                      entries: [
                        {
                          key: "d",
                          value: {
                            kind: "object",
                            entries: [
                              {
                                key: "e",
                                value: { kind: "json", json: '{\n  "f": 1\n}' },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
  });
});

describe("toolCallParams", () => {
  test("leaves out the activity sentence and keeps every other key", () => {
    expect(
      toolCallParams({
        activity: "Listing the components folder",
        reason: "a parameter that happens to share the legacy spelling",
        path: "src",
      }).map((param) => param.key),
    ).toEqual(["reason", "path"]);
  });
});
