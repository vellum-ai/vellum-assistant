import { describe, expect, test } from "bun:test";

import {
  inferMimeType,
  resolveAttachmentFilename,
} from "../attachment-naming.js";

describe("inferMimeType", () => {
  test("maps known extensions case-insensitively", () => {
    expect(inferMimeType("shot.PNG")).toBe("image/png");
    expect(inferMimeType("report.pdf")).toBe("application/pdf");
  });

  test("falls back to octet-stream for unknown or missing extensions", () => {
    expect(inferMimeType("desktop")).toBe("application/octet-stream");
    expect(inferMimeType("archive.xyz")).toBe("application/octet-stream");
  });
});

describe("resolveAttachmentFilename", () => {
  test("uses explicit filenames verbatim", () => {
    expect(
      resolveAttachmentFilename("custom.dat", "/tmp/shot.png", "explicit"),
    ).toBe("custom.dat");
  });

  test("honors labels with recognized extensions", () => {
    expect(
      resolveAttachmentFilename("nice-name.png", "/tmp/shot.png", "label"),
    ).toBe("nice-name.png");
  });

  test("keeps bare labels and appends the POSIX path extension", () => {
    expect(resolveAttachmentFilename("desktop", "/tmp/shot.png", "label")).toBe(
      "desktop.png",
    );
  });

  test("keeps bare labels and appends the Windows path extension", () => {
    expect(
      resolveAttachmentFilename(
        "desktop",
        "C:\\Users\\jason\\Pictures\\shot.png",
        "label",
      ),
    ).toBe("desktop.png");
  });

  test("bare labels to files sharing a basename resolve to unique names", () => {
    expect(
      resolveAttachmentFilename("first", "/workspace/a/result.png", "label"),
    ).toBe("first.png");
    expect(
      resolveAttachmentFilename("second", "/workspace/b/result.png", "label"),
    ).toBe("second.png");
  });

  test("falls back to the basename when the path has no extension", () => {
    expect(resolveAttachmentFilename("label", "/tmp/rawfile", "label")).toBe(
      "rawfile",
    );
  });

  test("uses the basename when no preferred name is given", () => {
    expect(
      resolveAttachmentFilename(undefined, "C:\\temp\\report.pdf", "label"),
    ).toBe("report.pdf");
    expect(resolveAttachmentFilename(undefined, "/tmp/report.pdf")).toBe(
      "report.pdf",
    );
  });

  test("ignores trailing separators", () => {
    expect(resolveAttachmentFilename(undefined, "/tmp/dir/", "label")).toBe(
      "dir",
    );
  });
});
