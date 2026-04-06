import { afterEach, describe, expect, mock, test } from "bun:test";
import { ContentMismatchError } from "../download-validation.js";
import type { SlackFile } from "./normalize.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { downloadSlackFile } = await import("./download.js");

function makeSlackFile(overrides?: Partial<SlackFile>): SlackFile {
  return {
    id: "F12345",
    name: "test-image.png",
    mimetype: "image/png",
    url_private_download: "https://files.slack.com/download/F12345",
    url_private: "https://files.slack.com/files-pri/F12345",
    ...overrides,
  };
}

/** Create a minimal valid PNG buffer that file-type can detect. */
function makePngBuffer(): ArrayBuffer {
  // PNG signature (8 bytes) + minimal IHDR chunk (25 bytes)
  const png = new Uint8Array([
    // PNG signature
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    // IHDR chunk: length (13)
    0x00, 0x00, 0x00, 0x0d,
    // IHDR type
    0x49, 0x48, 0x44, 0x52,
    // Width: 1
    0x00, 0x00, 0x00, 0x01,
    // Height: 1
    0x00, 0x00, 0x00, 0x01,
    // Bit depth, color type, compression, filter, interlace
    0x08, 0x02, 0x00, 0x00, 0x00,
    // CRC (placeholder)
    0x90, 0x77, 0x53, 0xde,
  ]);
  return png.buffer;
}

/** Create a plain text buffer (undetectable by file-type). */
function makeTextBuffer(): ArrayBuffer {
  return new TextEncoder().encode("hello world").buffer;
}

describe("downloadSlackFile", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("downloads file using url_private_download", async () => {
    const fileBuffer = makePngBuffer();
    fetchMock = mock(async () => new Response(fileBuffer));

    const file = makeSlackFile();
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(result.filename).toBe("test-image.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe(Buffer.from(fileBuffer).toString("base64"));

    // Verify the correct URL and auth header were used
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://files.slack.com/download/F12345");
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer xoxb-test-token",
    });
  });

  test("falls back to url_private when url_private_download is absent", async () => {
    const fileBuffer = makePngBuffer();
    fetchMock = mock(async () => new Response(fileBuffer));

    const file = makeSlackFile({
      url_private_download: undefined,
    });
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(result.filename).toBe("test-image.png");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://files.slack.com/files-pri/F12345");
  });

  test("throws when neither URL is present", async () => {
    const file = makeSlackFile({
      url_private_download: undefined,
      url_private: undefined,
    });

    await expect(downloadSlackFile(file, "xoxb-test-token")).rejects.toThrow(
      "Slack file F12345 has no download URL",
    );
  });

  test("uses redirect: manual to prevent auth header stripping", async () => {
    const fileBuffer = makePngBuffer();
    fetchMock = mock(async () => new Response(fileBuffer));

    const file = makeSlackFile();
    await downloadSlackFile(file, "xoxb-test-token");

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).redirect).toBe("manual");
  });

  test("follows redirect to CDN without auth header", async () => {
    const fileBuffer = makePngBuffer();
    let callCount = 0;
    fetchMock = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://files-edge.slack.com/signed/F12345" },
        });
      }
      return new Response(fileBuffer);
    });

    const file = makeSlackFile();
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call should be to the redirect URL without auth
    const [redirectUrl, redirectInit] = fetchMock.mock.calls[1];
    expect(redirectUrl).toBe("https://files-edge.slack.com/signed/F12345");
    expect((redirectInit as RequestInit).headers).toBeUndefined();
    expect(result.mimeType).toBe("image/png");
  });

  test("throws when redirect has no Location header", async () => {
    fetchMock = mock(
      async () => new Response(null, { status: 302 }),
    );

    const file = makeSlackFile();

    await expect(downloadSlackFile(file, "xoxb-test-token")).rejects.toThrow(
      "returned 302 redirect with no Location header",
    );
  });

  test("throws on HTTP error response", async () => {
    fetchMock = mock(
      async () =>
        new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    );

    const file = makeSlackFile();

    await expect(downloadSlackFile(file, "xoxb-test-token")).rejects.toThrow(
      "Failed to download Slack file F12345: 403 Forbidden",
    );
  });

  test("file.mimetype wins over detected and Content-Type", async () => {
    // Return a PNG buffer but set file.mimetype to a custom type
    const fileBuffer = makePngBuffer();
    fetchMock = mock(
      async () =>
        new Response(fileBuffer, {
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );

    const file = makeSlackFile({ mimetype: "image/webp" });
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(result.mimeType).toBe("image/webp");
  });

  test("falls back to detected MIME when file.mimetype is absent", async () => {
    const fileBuffer = makePngBuffer();
    fetchMock = mock(async () => new Response(fileBuffer));

    const file = makeSlackFile({ mimetype: undefined });
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(result.mimeType).toBe("image/png");
  });

  test("falls back to Content-Type when mimetype is absent and type is undetectable", async () => {
    const fileBuffer = makeTextBuffer();
    fetchMock = mock(
      async () =>
        new Response(fileBuffer, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    );

    const file = makeSlackFile({ mimetype: undefined });
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(result.mimeType).toBe("text/plain");
  });

  test("falls back to application/octet-stream when nothing else is available", async () => {
    const fileBuffer = makeTextBuffer();
    fetchMock = mock(async () => new Response(fileBuffer));

    const file = makeSlackFile({ mimetype: undefined });
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(result.mimeType).toBe("application/octet-stream");
  });

  test("falls back to slack_file_{id} when file.name is absent", async () => {
    const fileBuffer = makeTextBuffer();
    fetchMock = mock(async () => new Response(fileBuffer));

    const file = makeSlackFile({ name: undefined, mimetype: "text/plain" });
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(result.filename).toBe("slack_file_F12345");
  });

  test("throws ContentMismatchError when Slack returns HTML error page", async () => {
    const htmlBuffer = new TextEncoder().encode(
      "<!DOCTYPE html><html><body><h1>Error</h1></body></html>",
    ).buffer;
    fetchMock = mock(async () => new Response(htmlBuffer));

    const file = makeSlackFile({ mimetype: "image/png" });

    await expect(
      downloadSlackFile(file, "xoxb-test-token"),
    ).rejects.toBeInstanceOf(ContentMismatchError);
  });

  test("succeeds with valid image data when validation is active", async () => {
    const fileBuffer = makePngBuffer();
    fetchMock = mock(async () => new Response(fileBuffer));

    const file = makeSlackFile({ mimetype: "image/png" });
    const result = await downloadSlackFile(file, "xoxb-test-token");

    expect(result.filename).toBe("test-image.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe(Buffer.from(fileBuffer).toString("base64"));
  });
});
