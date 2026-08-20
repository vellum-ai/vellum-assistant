import { afterEach, describe, expect, mock, test } from "bun:test";
import pino from "pino";
import type { DiscordAttachmentReference } from "./attachments.js";

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

const { downloadDiscordFile } = await import("./download.js");
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function makeAttachment(
  overrides?: Partial<DiscordAttachmentReference>,
): DiscordAttachmentReference {
  return {
    id: "attachment-1",
    filename: "photo.png",
    size: 10,
    content_type: "image/png",
    url: "https://cdn.discord.test/attachments/1/photo.png?ex=abc&is=def&hm=ghi",
    ...overrides,
  };
}

function makePngBuffer(): ArrayBuffer {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]).buffer;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

describe("downloadDiscordFile", () => {
  test("downloads from the signed payload URL without authorization", async () => {
    const buffer = makePngBuffer();
    fetchMock = mock(async () => new Response(buffer));

    const attachment = makeAttachment();
    const result = await downloadDiscordFile(attachment, MAX_ATTACHMENT_BYTES);

    expect(result.filename).toBe("photo.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe(Buffer.from(buffer).toString("base64"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(attachment.url);
    expect(init?.headers).toBeUndefined();
  });

  test("throws for a non-OK response", async () => {
    fetchMock = mock(
      async () =>
        new Response("expired", { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      downloadDiscordFile(makeAttachment(), MAX_ATTACHMENT_BYTES),
    ).rejects.toThrow(
      "Failed to download Discord file attachment-1: 403 Forbidden",
    );
  });

  test("prefers payload, sniffed, response, then fallback MIME types", async () => {
    fetchMock = mock(
      async () =>
        new Response(new TextEncoder().encode("plain text"), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    );
    expect(
      (
        await downloadDiscordFile(
          makeAttachment({ content_type: "text/csv" }),
          MAX_ATTACHMENT_BYTES,
        )
      ).mimeType,
    ).toBe("text/csv");

    fetchMock = mock(
      async () =>
        new Response(makePngBuffer(), {
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );
    expect(
      (
        await downloadDiscordFile(
          makeAttachment({ content_type: undefined }),
          MAX_ATTACHMENT_BYTES,
        )
      ).mimeType,
    ).toBe("image/png");

    fetchMock = mock(
      async () =>
        new Response(new TextEncoder().encode("plain text"), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    );
    expect(
      (
        await downloadDiscordFile(
          makeAttachment({ content_type: undefined }),
          MAX_ATTACHMENT_BYTES,
        )
      ).mimeType,
    ).toBe("text/plain");

    fetchMock = mock(
      async () => new Response(new TextEncoder().encode("plain text")),
    );
    expect(
      (
        await downloadDiscordFile(
          makeAttachment({ content_type: undefined }),
          MAX_ATTACHMENT_BYTES,
        )
      ).mimeType,
    ).toBe("application/octet-stream");
  });

  test("warns and continues for an undocumented CDN host", async () => {
    const lines: string[] = [];
    const log = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    );
    fetchMock = mock(async () => new Response(makePngBuffer()));

    await downloadDiscordFile(
      makeAttachment({ url: "https://cdn.discord.test/file" }),
      1024,
      log,
    );

    expect(lines.join("")).toContain(
      "Discord attachment URL uses an undocumented CDN host",
    );
  });
});
