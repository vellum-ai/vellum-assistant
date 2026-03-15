import { describe, expect, test } from "bun:test";

import { buildMultipartMime } from "../messaging/providers/gmail/mime-builder.js";

describe("buildMultipartMime", () => {
  test("produces valid base64url output", () => {
    const result = buildMultipartMime({
      to: "test@example.com",
      subject: "Test",
      body: "Hello",
      attachments: [
        {
          filename: "doc.txt",
          mimeType: "text/plain",
          data: Buffer.from("file content"),
        },
      ],
    });

    // base64url: no +, /, or = characters
    expect(result).not.toMatch(/[+/=]/);

    // Decode and verify structure
    const decoded = Buffer.from(
      result.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    expect(decoded).toContain("To: test@example.com");
    expect(decoded).toContain("Subject: Test");
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain("Content-Type: multipart/mixed");
    expect(decoded).toContain("Hello");
    expect(decoded).toContain(
      'Content-Disposition: attachment; filename="doc.txt"',
    );
  });

  test("includes In-Reply-To and References headers when inReplyTo is set", () => {
    const result = buildMultipartMime({
      to: "test@example.com",
      subject: "Re: Test",
      body: "Reply",
      inReplyTo: "<msg-id@example.com>",
      attachments: [
        {
          filename: "a.pdf",
          mimeType: "application/pdf",
          data: Buffer.from("pdf"),
        },
      ],
    });

    const decoded = Buffer.from(
      result.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    expect(decoded).toContain("In-Reply-To: <msg-id@example.com>");
    expect(decoded).toContain("References: <msg-id@example.com>");
  });

  test("handles multiple attachments", () => {
    const result = buildMultipartMime({
      to: "test@example.com",
      subject: "Multi",
      body: "Body",
      attachments: [
        { filename: "a.txt", mimeType: "text/plain", data: Buffer.from("aaa") },
        {
          filename: "b.png",
          mimeType: "image/png",
          data: Buffer.from("png-data"),
        },
      ],
    });

    const decoded = Buffer.from(
      result.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    expect(decoded).toContain('filename="a.txt"');
    expect(decoded).toContain('filename="b.png"');
    expect(decoded).toContain("Content-Type: image/png");
  });

  test("sanitizes CRLF from header values to prevent header injection", () => {
    const result = buildMultipartMime({
      to: "victim@example.com\r\nBcc: attacker@example.com",
      subject: "Fwd: Hello\r\nCc: attacker@example.com",
      body: "Body",
      cc: "team@example.com\nX-Injected: yes",
      bcc: "audit@example.com\r\nX-Another: value",
      inReplyTo: "<id@example.com>\nReferences: <evil@example.com>",
      attachments: [],
    });

    const decoded = Buffer.from(
      result.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");

    expect(decoded).toContain("To: victim@example.com Bcc: attacker@example.com");
    expect(decoded).toContain("Subject: Fwd: Hello Cc: attacker@example.com");
    expect(decoded).toContain("Cc: team@example.com X-Injected: yes");
    expect(decoded).toContain("Bcc: audit@example.com X-Another: value");
    expect(decoded).toContain(
      "In-Reply-To: <id@example.com> References: <evil@example.com>",
    );
    expect(decoded).not.toContain("\r\nBcc: attacker@example.com");
    expect(decoded).not.toContain("\r\nCc: attacker@example.com");
  });

});
