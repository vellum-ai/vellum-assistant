import { describe, expect, test } from "bun:test";

import { parseImportFailure } from "../migration-import.js";

describe("parseImportFailure", () => {
  test("parses a validation report", () => {
    const failure = parseImportFailure(
      JSON.stringify({
        success: false,
        reason: "validation_failed",
        errors: [
          {
            code: "entry_hash",
            message: "Checksum mismatch",
            path: "workspace/a.md",
          },
        ],
      }),
    );
    expect(failure).toEqual({
      reason: "validation_failed",
      errors: [{ message: "Checksum mismatch", path: "workspace/a.md" }],
    });
  });

  test("parses a plain message body", () => {
    expect(parseImportFailure('{"message":"disk full"}')).toEqual({
      message: "disk full",
    });
  });

  test("returns null for text that is not an import failure", () => {
    expect(parseImportFailure("not json")).toBeNull();
    expect(parseImportFailure('{"job_id":"abc"}')).toBeNull();
  });
});
