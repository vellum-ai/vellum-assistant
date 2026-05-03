import { describe, expect, test } from "bun:test";

import { stripLegacySparseSuffix } from "../qdrant-client.js";

describe("stripLegacySparseSuffix", () => {
  test("strips a trailing :sparse-v<digit> suffix", () => {
    expect(
      stripLegacySparseSuffix("gemini:gemini-embedding-2-preview:sparse-v3"),
    ).toBe("gemini:gemini-embedding-2-preview");
  });

  test("strips multi-digit version suffixes", () => {
    expect(stripLegacySparseSuffix("openai:text-embed-3:sparse-v42")).toBe(
      "openai:text-embed-3",
    );
  });

  test("returns the input unchanged when no suffix is present", () => {
    expect(stripLegacySparseSuffix("gemini:gemini-embedding-2-preview")).toBe(
      "gemini:gemini-embedding-2-preview",
    );
  });

  test("does not strip a non-trailing :sparse-v segment", () => {
    expect(stripLegacySparseSuffix("foo:sparse-v3:bar")).toBe(
      "foo:sparse-v3:bar",
    );
  });

  test("does not strip when the version part is missing", () => {
    expect(stripLegacySparseSuffix("provider:model:sparse-v")).toBe(
      "provider:model:sparse-v",
    );
  });

  test("normalizes legacy and current sentinels to the same value", () => {
    const legacy = "gemini:gemini-embedding-2-preview:sparse-v2";
    const current = "gemini:gemini-embedding-2-preview";
    expect(stripLegacySparseSuffix(legacy)).toBe(
      stripLegacySparseSuffix(current),
    );
  });

  test("differentiates sentinels that diverge on the dense identity", () => {
    const a = "gemini:gemini-embedding-2-preview:sparse-v2";
    const b = "openai:text-embedding-3-small:sparse-v2";
    expect(stripLegacySparseSuffix(a)).not.toBe(stripLegacySparseSuffix(b));
  });
});
