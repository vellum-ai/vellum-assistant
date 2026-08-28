import { describe, expect, test } from "bun:test";

import {
  baseMimeType,
  extensionOf,
  type LocalFileKind,
  resolveLocalFileType,
  sniffMimeType,
} from "@/domains/chat/utils/mime-sniff";

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

/** Build a fixture head, padded so short signatures look like real files. */
function head(...parts: Array<number[] | string>): Uint8Array {
  const values: number[] = [];
  for (const part of parts) {
    values.push(...(typeof part === "string" ? ascii(part) : part));
  }
  while (values.length < 32) {
    values.push(0x00);
  }
  return new Uint8Array(values);
}

const PNG = head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "IHDR");
const JPEG = head([0xff, 0xd8, 0xff, 0xe0], [0x00, 0x10], "JFIF");
const GIF = head("GIF89a");
const WEBP = head("RIFF", [0x24, 0x00, 0x00, 0x00], "WEBPVP8 ");
const BMP = head("BM", [0x46, 0x00, 0x00, 0x00]);
const PDF = head("%PDF-1.7");
const MP3_ID3 = head("ID3", [0x03, 0x00, 0x00]);
const MP3_FRAME = head([0xff, 0xfb, 0x90, 0x44]);
const AAC_ADTS = head([0xff, 0xf1, 0x4c, 0x80]);
const WAV = head("RIFF", [0x24, 0x08, 0x00, 0x00], "WAVEfmt ");
const OGG = head("OggS", [0x00, 0x02]);
const FLAC = head("fLaC", [0x00, 0x00, 0x00, 0x22]);
const M4A = head([0x00, 0x00, 0x00, 0x20], "ftypM4A ", "M4A mp42");
const MP4 = head([0x00, 0x00, 0x00, 0x18], "ftypisom", "isomiso2avc1");
const MOV = head(
  [0x00, 0x00, 0x00, 0x14],
  "ftypqt  ",
  [0x00, 0x00, 0x02, 0x00],
);
const WEBM = head(
  [0x1a, 0x45, 0xdf, 0xa3],
  [0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84],
  "webm",
);
const MATROSKA = head(
  [0x1a, 0x45, 0xdf, 0xa3],
  [0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88],
  "matroska",
);
const ZIP = head([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const SVG = head('<?xml version="1.0"?>\n<svg viewBox="0 0 8 8"></svg>');
const SVG_BARE = head('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML = head("<!doctype html>\n<html><body>hi</body></html>");
const MARKDOWN = head("# Release notes\n\nShipped the thing.\n");
const CSV = head("name,count\nalice,3\n");

describe("sniffMimeType: recognized signatures", () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["gif", GIF, "image/gif"],
    ["webp", WEBP, "image/webp"],
    ["bmp", BMP, "image/bmp"],
    ["pdf", PDF, "application/pdf"],
    ["mp3 with an ID3 tag", MP3_ID3, "audio/mpeg"],
    ["mp3 starting at a frame header", MP3_FRAME, "audio/mpeg"],
    ["wav", WAV, "audio/wav"],
    ["ogg", OGG, "audio/ogg"],
    ["flac", FLAC, "audio/flac"],
    ["m4a", M4A, "audio/mp4"],
    ["mp4", MP4, "video/mp4"],
    ["mov", MOV, "video/quicktime"],
    ["webm", WEBM, "video/webm"],
    ["matroska", MATROSKA, "video/x-matroska"],
    ["zip", ZIP, "application/zip"],
    ["svg with an xml prolog", SVG, "image/svg+xml"],
    ["svg without a prolog", SVG_BARE, "image/svg+xml"],
  ];

  for (const [label, bytes, expected] of cases) {
    test(label, () => {
      expect(sniffMimeType(bytes)).toBe(expected);
    });
  }
});

describe("sniffMimeType: inconclusive input", () => {
  test("empty bytes", () => {
    expect(sniffMimeType(new Uint8Array(0))).toBeNull();
  });

  test("plain text and markdown carry no signature", () => {
    expect(sniffMimeType(MARKDOWN)).toBeNull();
    expect(sniffMimeType(CSV)).toBeNull();
  });

  test("markup that is not svg-ish stays inconclusive", () => {
    expect(sniffMimeType(HTML)).toBeNull();
  });

  test("AAC frame headers are not mistaken for mp3", () => {
    // ADTS shares the sync bits but carries layer 00, which no MPEG audio
    // frame uses.
    expect(sniffMimeType(AAC_ADTS)).toBeNull();
  });

  test("unstructured binary", () => {
    expect(sniffMimeType(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});

describe("resolveLocalFileType: extension fallback", () => {
  const cases: Array<[string, string, LocalFileKind]> = [
    ["chart.png", "image/png", "image"],
    ["photo.jpg", "image/jpeg", "image"],
    ["photo.jpeg", "image/jpeg", "image"],
    ["loop.gif", "image/gif", "image"],
    ["hero.webp", "image/webp", "image"],
    ["logo.svg", "image/svg+xml", "image"],
    ["take.mp3", "audio/mpeg", "audio"],
    ["take.wav", "audio/wav", "audio"],
    ["take.m4a", "audio/mp4", "audio"],
    ["take.aac", "audio/aac", "audio"],
    ["take.ogg", "audio/ogg", "audio"],
    ["take.flac", "audio/flac", "audio"],
    ["clip.mp4", "video/mp4", "video"],
    ["clip.mov", "video/quicktime", "video"],
    ["clip.m4v", "video/mp4", "video"],
    ["clip.webm", "video/webm", "video"],
    ["report.pdf", "application/pdf", "pdf"],
  ];

  for (const [filename, mime, kind] of cases) {
    test(filename, () => {
      expect(
        resolveLocalFileType({
          sniffedMime: null,
          serverMime: null,
          filename,
        }),
      ).toEqual({ mime, kind });
    });
  }

  test("a generic server type does not shadow the extension map", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: null,
        serverMime: "application/octet-stream",
        filename: "take.m4a",
      }),
    ).toEqual({ mime: "audio/mp4", kind: "audio" });
  });

  test("server type wins over the extension map when it names a format", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: null,
        serverMime: "audio/x-m4a; charset=binary",
        filename: "take.m4a",
      }),
    ).toEqual({ mime: "audio/x-m4a", kind: "audio" });
  });

  test("unknown extension with no other signal", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: null,
        serverMime: null,
        filename: "archive.bin",
      }),
    ).toEqual({ mime: null, kind: "file" });
  });
});

describe("resolveLocalFileType: the bytes win", () => {
  test("a .png holding zip bytes is a file, not an image", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: "application/zip",
        serverMime: "image/png",
        filename: "chart.png",
      }),
    ).toEqual({ mime: "application/zip", kind: "file" });
  });

  test("a .mp4 holding png bytes is an image", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: "image/png",
        serverMime: "video/mp4",
        filename: "clip.mp4",
      }),
    ).toEqual({ mime: "image/png", kind: "image" });
  });

  test("a .docx holding png bytes keeps the sniffed type", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: "image/png",
        serverMime:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "brief.docx",
      }),
    ).toEqual({ mime: "image/png", kind: "image" });
  });

  test("svg markup only counts as an image under a .svg name", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: "image/svg+xml",
        serverMime: "text/html",
        filename: "page.html",
      }),
    ).toEqual({ mime: "text/html", kind: "file" });
  });
});

describe("resolveLocalFileType: documents are never media", () => {
  const cases: Array<[string, string | null]> = [
    ["notes.md", "text/markdown"],
    ["rows.csv", "text/csv"],
    [
      "deck.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["bundle.zip", "application/zip"],
  ];

  for (const [filename, serverMime] of cases) {
    test(filename, () => {
      expect(
        resolveLocalFileType({ sniffedMime: null, serverMime, filename }).kind,
      ).toBe("file");
    });
  }

  test("a zip referenced as an image still renders as a file", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: sniffMimeType(ZIP),
        serverMime: "image/png",
        filename: "bundle.png",
      }),
    ).toEqual({ mime: "application/zip", kind: "file" });
  });
});

describe("resolveLocalFileType: OOXML packages under their zip signature", () => {
  const cases: Array<[string, string]> = [
    [
      "brief.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    [
      "budget.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  ];

  for (const [filename, mime] of cases) {
    test(`${filename} resolves to its Office type`, () => {
      expect(
        resolveLocalFileType({
          sniffedMime: sniffMimeType(ZIP),
          serverMime: null,
          filename,
        }),
      ).toEqual({ mime, kind: "file" });
    });

    test(`${filename} keeps its Office type over a generic server type`, () => {
      expect(
        resolveLocalFileType({
          sniffedMime: sniffMimeType(ZIP),
          serverMime: "application/octet-stream",
          filename,
        }),
      ).toEqual({ mime, kind: "file" });
    });
  }

  test("an uppercase extension resolves the same way", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: sniffMimeType(ZIP),
        serverMime: null,
        filename: "BRIEF.DOCX",
      }).mime,
    ).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  test("a plain zip stays a plain zip", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: sniffMimeType(ZIP),
        serverMime: null,
        filename: "bundle.zip",
      }),
    ).toEqual({ mime: "application/zip", kind: "file" });
  });

  test("zip bytes under an unrelated extension stay a zip", () => {
    expect(
      resolveLocalFileType({
        sniffedMime: sniffMimeType(ZIP),
        serverMime: null,
        filename: "notes.md",
      }),
    ).toEqual({ mime: "application/zip", kind: "file" });
  });
});

describe("baseMimeType", () => {
  test("drops parameters and normalizes case and whitespace", () => {
    expect(baseMimeType("application/pdf; charset=binary")).toBe(
      "application/pdf",
    );
    expect(baseMimeType(" Image/JPEG ")).toBe("image/jpeg");
    expect(baseMimeType("")).toBe("");
  });
});

describe("extensionOf", () => {
  test("reads the last segment's suffix, lowercased and trimmed", () => {
    expect(extensionOf("photo.JPG")).toBe("jpg");
    expect(extensionOf("photo.jpg ")).toBe("jpg");
    expect(extensionOf("photos.2024/report")).toBe("");
    expect(extensionOf(".hidden")).toBe("");
    expect(extensionOf("pdf")).toBe("");
  });
});
