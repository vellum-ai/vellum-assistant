import { describe, expect, test } from "bun:test";

import { parseNdjson } from "../runtime/ndjson";

async function* chunks(values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

describe("parseNdjson", () => {
  test("parses newline-delimited JSON across chunk boundaries", async () => {
    const parsed = [];
    for await (const item of parseNdjson(
      chunks(['{"a":', '1}\n{"b":2', "}\n"]),
    )) {
      parsed.push(item);
    }

    expect(parsed).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("parses a final line without a trailing newline", async () => {
    const parsed = [];
    for await (const item of parseNdjson(chunks(['{"ok":true}']))) {
      parsed.push(item);
    }

    expect(parsed).toEqual([{ ok: true }]);
  });
});
