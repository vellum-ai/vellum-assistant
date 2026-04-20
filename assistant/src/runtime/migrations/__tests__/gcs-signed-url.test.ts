/**
 * Tests for the GCS signed-URL validator.
 *
 * Covers:
 * - A valid V4-signed URL (`X-Goog-Signature=...`) is accepted and the
 *   returned host/path match the input.
 * - A valid V2-signed URL (`Signature=...`) is accepted.
 * - `http://` is rejected with reason `scheme`.
 * - A non-GCS host is rejected with reason `host`.
 * - A GCS URL with no signature query param is rejected with reason
 *   `missing_signature`.
 * - Path traversal (`/bucket/../foo`) is rejected with reason
 *   `path_traversal`, even though the URL parser would normalize it.
 * - A malformed URL string is rejected with reason `invalid_url`.
 */

import { describe, expect, test } from "bun:test";

import { validateGcsSignedUrl } from "../gcs-signed-url.js";

describe("validateGcsSignedUrl", () => {
  test("accepts a V4-signed URL", () => {
    const url =
      "https://storage.googleapis.com/my-bucket/path/to/object.tgz" +
      "?X-Goog-Algorithm=GOOG4-RSA-SHA256" +
      "&X-Goog-Credential=service-account%40project.iam.gserviceaccount.com" +
      "&X-Goog-Date=20260420T000000Z" +
      "&X-Goog-Expires=3600" +
      "&X-Goog-SignedHeaders=host" +
      "&X-Goog-Signature=deadbeef";

    const result = validateGcsSignedUrl(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.host).toBe("storage.googleapis.com");
      expect(result.path).toBe("/my-bucket/path/to/object.tgz");
    }
  });

  test("accepts a V2-signed URL", () => {
    const url =
      "https://storage.googleapis.com/my-bucket/object.tgz" +
      "?GoogleAccessId=service-account%40project.iam.gserviceaccount.com" +
      "&Expires=1700000000" +
      "&Signature=abc123";

    const result = validateGcsSignedUrl(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.host).toBe("storage.googleapis.com");
      expect(result.path).toBe("/my-bucket/object.tgz");
    }
  });

  test("rejects http:// scheme", () => {
    const url =
      "http://storage.googleapis.com/my-bucket/object.tgz" +
      "?X-Goog-Signature=deadbeef";

    const result = validateGcsSignedUrl(url);
    expect(result).toEqual({ ok: false, reason: "scheme" });
  });

  test("rejects a non-GCS host", () => {
    const url =
      "https://evil.com/my-bucket/object.tgz" + "?X-Goog-Signature=deadbeef";

    const result = validateGcsSignedUrl(url);
    expect(result).toEqual({ ok: false, reason: "host" });
  });

  test("rejects a GCS URL with no signature", () => {
    const url = "https://storage.googleapis.com/bucket/key";

    const result = validateGcsSignedUrl(url);
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  test("rejects path traversal", () => {
    const url =
      "https://storage.googleapis.com/bucket/../foo" +
      "?X-Goog-Signature=deadbeef";

    const result = validateGcsSignedUrl(url);
    expect(result).toEqual({ ok: false, reason: "path_traversal" });
  });

  test("rejects a malformed URL", () => {
    const result = validateGcsSignedUrl("not a url at all");
    expect(result).toEqual({ ok: false, reason: "invalid_url" });
  });
});
