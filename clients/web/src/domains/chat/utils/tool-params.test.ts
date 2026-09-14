import { describe, expect, test } from "bun:test";

import { toolCallParams, toToolParams } from "@/domains/chat/utils/tool-params";

describe("toToolParams", () => {
  test("renders scalars as strings and structures as JSON, in order", () => {
    expect(
      toToolParams({
        path: "src/a.ts",
        max_results: 20,
        case_insensitive: false,
        cursor: null,
        filter: { glob: "*.ts" },
      }),
    ).toEqual([
      { key: "path", scalar: "src/a.ts", json: null },
      { key: "max_results", scalar: "20", json: null },
      { key: "case_insensitive", scalar: "false", json: null },
      { key: "cursor", scalar: "null", json: null },
      { key: "filter", scalar: null, json: '{\n  "glob": "*.ts"\n}' },
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
