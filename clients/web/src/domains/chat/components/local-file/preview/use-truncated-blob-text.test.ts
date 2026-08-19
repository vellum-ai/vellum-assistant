import { describe, expect, test } from "bun:test";

import { truncateBlobForDisplay } from "@/domains/chat/components/local-file/preview/use-truncated-blob-text";

const CAP = 16;

describe("truncateBlobForDisplay", () => {
  test("a blob under the cap is kept whole", () => {
    const blob = new Blob(["a".repeat(CAP - 1)]);

    const result = truncateBlobForDisplay(blob, CAP);

    expect(result.truncated).toBe(false);
    expect(result.blob.size).toBe(CAP - 1);
  });

  test("a blob exactly at the cap is kept whole", () => {
    const blob = new Blob(["a".repeat(CAP)]);

    const result = truncateBlobForDisplay(blob, CAP);

    expect(result.truncated).toBe(false);
    expect(result.blob.size).toBe(CAP);
  });

  test("one byte past the cap is cut before decoding and reported", async () => {
    const blob = new Blob([`${"a".repeat(CAP)}b`]);

    const result = truncateBlobForDisplay(blob, CAP);

    expect(result.truncated).toBe(true);
    expect(result.blob.size).toBe(CAP);
    expect(await result.blob.text()).toBe("a".repeat(CAP));
  });

  test("an empty blob is not treated as truncated", () => {
    const result = truncateBlobForDisplay(new Blob([]), CAP);

    expect(result.truncated).toBe(false);
    expect(result.blob.size).toBe(0);
  });

  test("a cut that splits a multi-byte character decodes to a replacement char at the boundary", async () => {
    // "é" is two bytes in UTF-8; a cap of 15 ASCII bytes plus one byte of the
    // pair leaves a dangling lead byte, which decodes to U+FFFD.
    const blob = new Blob([`${"a".repeat(CAP - 1)}é`]);

    const result = truncateBlobForDisplay(blob, CAP);

    expect(result.truncated).toBe(true);
    expect((await result.blob.text()).endsWith("�")).toBe(true);
  });
});
