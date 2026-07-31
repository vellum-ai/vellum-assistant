/**
 * Tests for `formatFileSize` — the human-readable byte formatter used by the
 * workspace browser, file viewer, and bundle confirmation page.
 *
 * Pure function (no React, no mocks), so these run fast and standalone.
 */

import { describe, expect, test } from "bun:test";

import { formatFileSize } from "./format-file-size";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

describe("formatFileSize", () => {
  test("returns the fallback for null/undefined", () => {
    expect(formatFileSize(null)).toBe("");
    expect(formatFileSize(undefined)).toBe("");
    expect(formatFileSize(null, "Unknown size")).toBe("Unknown size");
  });

  test("formats sub-kilobyte values as bytes", () => {
    expect(formatFileSize(0)).toBe("0 bytes");
    expect(formatFileSize(512)).toBe("512 bytes");
    expect(formatFileSize(1023)).toBe("1023 bytes");
  });

  test("formats kilobytes with a rounded integer", () => {
    expect(formatFileSize(KB)).toBe("1 KB");
    expect(formatFileSize(15 * KB)).toBe("15 KB");
    expect(formatFileSize(MB - 1)).toBe("1024 KB");
  });

  test("formats megabytes with one decimal", () => {
    expect(formatFileSize(MB)).toBe("1.0 MB");
    expect(formatFileSize(56.4 * MB)).toBe("56.4 MB");
  });

  test("switches to GB at 100 MiB and up", () => {
    // 100 MiB is the threshold; 99 MiB stays in MB.
    expect(formatFileSize(99 * MB)).toBe("99.0 MB");
    expect(formatFileSize(100 * MB)).toBe("0.1 GB");
    expect(formatFileSize(127.2 * MB)).toBe("0.1 GB");
    expect(formatFileSize(543.1 * MB)).toBe("0.5 GB");
    expect(formatFileSize(11069.9 * MB)).toBe("10.8 GB");
    expect(formatFileSize(GB)).toBe("1.0 GB");
  });
});
