/**
 * Unit tests for the assistant-side Slack file downloader used by the
 * thread-backfill image-hydration path.
 *
 * The downloader has three contract-level behaviors worth pinning:
 *  1. URL selection — `url_private_download` is preferred over `url_private`.
 *  2. Bearer auth — the bot token MUST be sent on the initial request.
 *  3. Manual cross-origin redirect handling — the CDN URL is signed and the
 *     Authorization header MUST NOT be re-sent on the second hop (Slack
 *     rejects the signed URL when an unexpected Authorization is present).
 *  4. Returns null when no usable URL is present.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { downloadSlackFile } from "../download.js";

interface CapturedFetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: CapturedFetchCall[];
let responses: Response[];
let originalFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  responses = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      init,
    });
    const next = responses.shift();
    if (!next) {
      throw new Error("downloadSlackFile test: no canned response available");
    }
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadSlackFile", () => {
  test("returns null when neither url_private_download nor url_private is present", async () => {
    const result = await downloadSlackFile(
      { name: "screenshot.png", mimetype: "image/png" },
      "xoxb-test",
    );
    expect(result).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("prefers url_private_download over url_private", async () => {
    responses.push(
      new Response(new Uint8Array([1, 2, 3]).buffer, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    await downloadSlackFile(
      {
        id: "F1",
        name: "shot.png",
        mimetype: "image/png",
        urlPrivateDownload: "https://files.slack.com/files-pri/T/F1/download",
        urlPrivate: "https://files.slack.com/files-pri/T/F1/inline",
      },
      "xoxb-test",
    );
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "https://files.slack.com/files-pri/T/F1/download",
    );
  });

  test("sends bot token as Bearer on the initial request and base64-encodes the body", async () => {
    responses.push(
      new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    const result = await downloadSlackFile(
      {
        id: "F1",
        name: "shot.png",
        mimetype: "image/png",
        urlPrivate: "https://files.slack.com/files-pri/T/F1/inline",
      },
      "xoxb-test-token",
    );
    expect(calls.length).toBe(1);
    const auth = (calls[0].init?.headers as Record<string, string>)
      ?.Authorization;
    expect(auth).toBe("Bearer xoxb-test-token");
    expect(calls[0].init?.redirect).toBe("manual");
    expect(result).not.toBeNull();
    expect(result?.filename).toBe("shot.png");
    expect(result?.mimeType).toBe("image/png");
    // 0xdeadbeef → "3q2+7w==" in base64.
    expect(result?.data).toBe("3q2+7w==");
  });

  test("follows a 302 to the signed CDN URL without re-sending the bearer token", async () => {
    responses.push(
      new Response(null, {
        status: 302,
        headers: {
          Location:
            "https://files-edge.slack.com/files-tmb/T-F1-abc/cdn-signed?t=1700000000",
        },
      }),
    );
    responses.push(
      new Response(new Uint8Array([1, 2]).buffer, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    );
    const result = await downloadSlackFile(
      {
        id: "F1",
        name: "photo.jpg",
        mimetype: "image/jpeg",
        urlPrivateDownload: "https://files.slack.com/files-pri/T/F1/download",
      },
      "xoxb-test",
    );
    expect(calls.length).toBe(2);
    expect(calls[0].init?.redirect).toBe("manual");
    const secondAuth = (calls[1].init?.headers as Record<string, string>)
      ?.Authorization;
    expect(secondAuth).toBeUndefined();
    expect(calls[1].url).toBe(
      "https://files-edge.slack.com/files-tmb/T-F1-abc/cdn-signed?t=1700000000",
    );
    expect(result?.data).toBe(Buffer.from([1, 2]).toString("base64"));
  });

  test("resolves a relative Location header against the original URL", async () => {
    responses.push(
      new Response(null, {
        status: 302,
        headers: { Location: "/files-tmb/cdn-signed?t=1700" },
      }),
    );
    responses.push(
      new Response(new Uint8Array([9]).buffer, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    await downloadSlackFile(
      {
        id: "F1",
        name: "x.png",
        urlPrivateDownload: "https://files.slack.com/a/b/download",
      },
      "xoxb-test",
    );
    expect(calls[1].url).toBe(
      "https://files.slack.com/files-tmb/cdn-signed?t=1700",
    );
  });

  test("throws when the second hop responds non-2xx", async () => {
    responses.push(
      new Response(null, {
        status: 302,
        headers: { Location: "https://files-edge.slack.com/cdn?t=1" },
      }),
    );
    responses.push(
      new Response(null, { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      downloadSlackFile(
        {
          id: "F1",
          name: "x.png",
          urlPrivateDownload: "https://files.slack.com/a/b/download",
        },
        "xoxb-test",
      ),
    ).rejects.toThrow(/403/);
  });

  test("throws when a redirect has no Location header", async () => {
    responses.push(new Response(null, { status: 302 }));
    await expect(
      downloadSlackFile(
        {
          id: "F1",
          name: "x.png",
          urlPrivateDownload: "https://files.slack.com/a/b/download",
        },
        "xoxb-test",
      ),
    ).rejects.toThrow(/no Location header/);
  });

  test("falls back to response Content-Type when file.mimetype is absent", async () => {
    responses.push(
      new Response(new Uint8Array([1]).buffer, {
        status: 200,
        headers: { "Content-Type": "image/webp; charset=binary" },
      }),
    );
    const result = await downloadSlackFile(
      {
        id: "F1",
        name: "photo.webp",
        urlPrivate: "https://files.slack.com/files-pri/T/F1/inline",
      },
      "xoxb-test",
    );
    expect(result?.mimeType).toBe("image/webp");
  });
});
