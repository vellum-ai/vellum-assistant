/**
 * Pins the shared Gmail field readers. `extractPlainTextBody` is read by both
 * the messaging adapter and the notification normalizer's `fetchFull`, and the
 * latter exists only to spend an API call on the real body, so an HTML-only
 * message returning its snippet would make that call pointless.
 */

import { describe, expect, test } from "bun:test";

import {
  extractHeader,
  extractPlainTextBody,
  parseFromHeader,
} from "./message-fields.js";
import type { GmailMessage, GmailMessagePart } from "./types.js";

function part(mimeType: string, body: string): GmailMessagePart {
  return {
    mimeType,
    body: { data: Buffer.from(body).toString("base64url") },
  };
}

function message(
  payload: GmailMessagePart | undefined,
  snippet?: string,
): GmailMessage {
  return { id: "msg-1", threadId: "thread-1", payload, snippet };
}

describe("extractHeader", () => {
  test("matches case-insensitively and returns empty for a missing header", () => {
    const msg: GmailMessage = {
      id: "msg-1",
      threadId: "thread-1",
      payload: { headers: [{ name: "In-Reply-To", value: "<parent@x>" }] },
    };
    expect(extractHeader(msg, "in-reply-to")).toBe("<parent@x>");
    expect(extractHeader(msg, "List-Unsubscribe")).toBe("");
  });
});

describe("parseFromHeader", () => {
  test("splits a display name from its address", () => {
    expect(parseFromHeader("Example User <user@example.com>")).toEqual({
      displayName: "Example User",
      address: "user@example.com",
    });
  });

  test("treats a bare address as its own display name", () => {
    expect(parseFromHeader("user@example.com")).toEqual({
      displayName: "user@example.com",
      address: "user@example.com",
    });
  });
});

describe("extractPlainTextBody", () => {
  test("returns a text/plain body verbatim", () => {
    expect(
      extractPlainTextBody(message(part("text/plain", "Line one\nLine two"))),
    ).toBe("Line one\nLine two");
  });

  test("prefers text/plain over the HTML alternative", () => {
    expect(
      extractPlainTextBody(
        message({
          mimeType: "multipart/alternative",
          parts: [
            part("text/html", "<p>markup</p>"),
            part("text/plain", "the plain one"),
          ],
        }),
      ),
    ).toBe("the plain one");
  });

  test("converts an HTML-only body instead of falling back to the snippet", () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body>" +
      "<p>Hello there</p><div>Second line</div>" +
      "<a href='https://example.com'>a link</a></body></html>";

    expect(
      extractPlainTextBody(
        message(
          {
            mimeType: "multipart/alternative",
            parts: [part("text/html", html)],
          },
          "Hello ther",
        ),
      ),
    ).toBe("Hello there\n\nSecond line\na link");
  });

  test("decodes named and numeric entities", () => {
    expect(
      extractPlainTextBody(
        message(
          part(
            "text/html",
            "R&amp;D &lt;tag&gt; &quot;quoted&quot; &#39;apos&#39; &#x2705;&nbsp;done",
          ),
        ),
      ),
    ).toBe("R&D <tag> \"quoted\" 'apos' ✅ done");
  });

  test("drops script content rather than reading it as text", () => {
    expect(
      extractPlainTextBody(
        message(
          part(
            "text/html",
            "<script>var secret = 1;</script><p>Visible</p><!-- hidden -->",
          ),
        ),
      ),
    ).toBe("Visible");
  });

  test("falls back to the snippet only when there is no readable part", () => {
    expect(
      extractPlainTextBody(
        message(
          { mimeType: "image/png", body: { attachmentId: "att-1" } },
          "a preview",
        ),
      ),
    ).toBe("a preview");
  });

  test("falls back to the snippet when the HTML carries no text", () => {
    expect(
      extractPlainTextBody(
        message(part("text/html", "<div><img src='x.png'></div>"), "a preview"),
      ),
    ).toBe("a preview");
  });

  test("returns empty when the message has no payload", () => {
    expect(extractPlainTextBody(message(undefined, "a preview"))).toBe("");
  });
});
