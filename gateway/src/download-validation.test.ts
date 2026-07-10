import { describe, expect, test } from "bun:test";
import {
  ContentMismatchError,
  validateDownloadedContent,
} from "@vellumai/download-validation";

/**
 * CI-coverage smoke test for the shared download validation consumed by the
 * gateway inbound path. The exhaustive behavior matrix lives in the package
 * itself (`packages/download-validation`); this pins the load-bearing contract
 * the gateway relies on so gateway CI fails if the guard regresses.
 */

/** Minimal valid PNG buffer that file-type can detect. */
function makePngBuffer(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]);
}

describe("validateDownloadedContent (gateway consumption)", () => {
  test("throws ContentMismatchError when HTML is received instead of image/png", async () => {
    const buffer = new TextEncoder().encode(
      "<!DOCTYPE html><html><body><h1>Access Denied</h1></body></html>",
    );

    await expect(
      validateDownloadedContent(buffer, "image/png", "F001"),
    ).rejects.toThrow(ContentMismatchError);
  });

  test("passes for a valid PNG buffer declared as image/png", async () => {
    await validateDownloadedContent(makePngBuffer(), "image/png", "F002");
  });
});
