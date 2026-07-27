/**
 * Tests for the shared byte-range response builder.
 *
 * The behaviour pinned here was previously duplicated between the workspace
 * file-content route and the attachment content route. The interesting cases
 * are the edges neither route's own tests reached: suffix ranges, open-ended
 * ranges, clamping past EOF, and the difference between an unparseable range
 * (whole file at 200) and an unsatisfiable one (416).
 */

import { describe, expect, test } from "bun:test";

import { RangeNotSatisfiableError } from "../errors.js";
import { fileRangeResponse } from "../file-range.js";

const CONTENT = "abcdefghij";
const SIZE = CONTENT.length;

function respond(rangeHeader?: string) {
  return fileRangeResponse({
    file: new Blob([CONTENT]),
    sizeBytes: SIZE,
    mimeType: "text/plain",
    rangeHeader,
  });
}

async function bodyText(body: BodyInit | null): Promise<string> {
  return await (body as Blob).text();
}

describe("fileRangeResponse — no range requested", () => {
  test("serves the whole file and advertises range support", async () => {
    const res = respond();

    // No status override: the route-level callable already resolved 200 from
    // the absent request header.
    expect(res.status).toBeUndefined();
    expect(res.headers["Content-Type"]).toBe("text/plain");
    expect(res.headers["Content-Length"]).toBe("10");
    expect(res.headers["Accept-Ranges"]).toBe("bytes");
    expect(res.headers["Content-Range"]).toBeUndefined();
    expect(await bodyText(res.body)).toBe(CONTENT);
  });
});

describe("fileRangeResponse — explicit ranges", () => {
  test("serves a closed range", async () => {
    const res = respond("bytes=2-5");

    expect(res.status).toBeUndefined();
    expect(res.headers["Content-Range"]).toBe("bytes 2-5/10");
    expect(res.headers["Content-Length"]).toBe("4");
    expect(await bodyText(res.body)).toBe("cdef");
  });

  test("serves an open-ended range to the end of the file", async () => {
    const res = respond("bytes=7-");

    expect(res.headers["Content-Range"]).toBe("bytes 7-9/10");
    expect(res.headers["Content-Length"]).toBe("3");
    expect(await bodyText(res.body)).toBe("hij");
  });

  test("clamps an end that runs past the last byte", async () => {
    const res = respond("bytes=8-99");

    expect(res.headers["Content-Range"]).toBe("bytes 8-9/10");
    expect(await bodyText(res.body)).toBe("ij");
  });

  test("serves a single byte", async () => {
    const res = respond("bytes=0-0");

    expect(res.headers["Content-Range"]).toBe("bytes 0-0/10");
    expect(res.headers["Content-Length"]).toBe("1");
    expect(await bodyText(res.body)).toBe("a");
  });

  test("serves the entire file when asked for it explicitly", async () => {
    const res = respond("bytes=0-9");

    expect(res.headers["Content-Range"]).toBe("bytes 0-9/10");
    expect(await bodyText(res.body)).toBe(CONTENT);
  });
});

describe("fileRangeResponse — suffix ranges", () => {
  test("serves the last N bytes", async () => {
    const res = respond("bytes=-3");

    expect(res.headers["Content-Range"]).toBe("bytes 7-9/10");
    expect(await bodyText(res.body)).toBe("hij");
  });

  test("clamps a suffix longer than the file to the whole file", async () => {
    const res = respond("bytes=-500");

    expect(res.headers["Content-Range"]).toBe("bytes 0-9/10");
    expect(await bodyText(res.body)).toBe(CONTENT);
  });
});

describe("fileRangeResponse — ranges that cannot be served", () => {
  test("an unparseable range serves the whole file, corrected to 200", async () => {
    const res = respond("bytes=abc");

    // The route-level callable resolved 206 from the header's presence alone.
    // Only the handler can see that the header was garbage, so it overrides.
    expect(res.status).toBe(200);
    expect(res.headers["Content-Length"]).toBe("10");
    expect(res.headers["Content-Range"]).toBeUndefined();
    expect(await bodyText(res.body)).toBe(CONTENT);
  });

  test("a range starting past the end is not satisfiable", () => {
    expect(() => respond("bytes=10-20")).toThrow(RangeNotSatisfiableError);
  });

  test("an inverted range is not satisfiable", () => {
    expect(() => respond("bytes=8-3")).toThrow(RangeNotSatisfiableError);
  });

  test("the 416 carries the total size so a client can retry", () => {
    try {
      respond("bytes=99-");
      throw new Error("expected a RangeNotSatisfiableError");
    } catch (err) {
      expect(err).toBeInstanceOf(RangeNotSatisfiableError);
      expect((err as RangeNotSatisfiableError).message).toBe("bytes */10");
    }
  });
});

describe("fileRangeResponse — empty files", () => {
  test("serves an empty file with no range requested", async () => {
    const res = fileRangeResponse({
      file: new Blob([]),
      sizeBytes: 0,
      mimeType: "application/octet-stream",
      rangeHeader: undefined,
    });

    expect(res.headers["Content-Length"]).toBe("0");
    expect(await bodyText(res.body)).toBe("");
  });

  test("any range over an empty file is unsatisfiable", () => {
    expect(() =>
      fileRangeResponse({
        file: new Blob([]),
        sizeBytes: 0,
        mimeType: "application/octet-stream",
        rangeHeader: "bytes=0-",
      }),
    ).toThrow(RangeNotSatisfiableError);
  });
});
