import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import type { EmailAttachment } from "./normalize.js";

// --- Mocks ----------------------------------------------------------------

class MockAttachmentValidationError extends Error {}

let uploadCounter = 0;
const uploadAttachmentMock = mock(() =>
  Promise.resolve({ id: `att-${++uploadCounter}` }),
);

mock.module("../runtime/client.js", () => ({
  uploadAttachment: uploadAttachmentMock,
  AttachmentValidationError: MockAttachmentValidationError,
  CircuitBreakerOpenError: class extends Error {},
  resetConversation: mock(() => Promise.resolve()),
}));

const { ingestEmailAttachments, appendFailedEmailAttachmentNotice } =
  await import("./attachments.js");

// --- Helpers --------------------------------------------------------------

const silentLog = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Logger;

const config = {
  maxAttachmentBytes: {
    telegram: 20 * 1024 * 1024,
    slack: 100 * 1024 * 1024,
    whatsapp: 16 * 1024 * 1024,
    email: 25 * 1024 * 1024,
    default: 100 * 1024 * 1024,
  },
  maxAttachmentConcurrency: 3,
} as unknown as GatewayConfig;

function att(overrides?: Partial<EmailAttachment>): EmailAttachment {
  return {
    filename: "receipt.pdf",
    contentType: "application/pdf",
    content: Buffer.from("hello").toString("base64"),
    ...overrides,
  };
}

beforeEach(() => {
  uploadCounter = 0;
  uploadAttachmentMock.mockClear();
  uploadAttachmentMock.mockImplementation(() =>
    Promise.resolve({ id: `att-${++uploadCounter}` }),
  );
});

// --- Tests ----------------------------------------------------------------

describe("ingestEmailAttachments", () => {
  it("returns empty result for undefined or empty attachments", async () => {
    expect(await ingestEmailAttachments(config, undefined, silentLog)).toEqual({
      attachmentIds: [],
      failedAttachmentNames: [],
      oversizedAttachments: [],
    });
    expect(await ingestEmailAttachments(config, [], silentLog)).toEqual({
      attachmentIds: [],
      failedAttachmentNames: [],
      oversizedAttachments: [],
    });
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
  });

  it("uploads attachments and returns their ids", async () => {
    const result = await ingestEmailAttachments(
      config,
      [
        att({ filename: "a.pdf" }),
        att({ filename: "b.png", contentType: "image/png" }),
      ],
      silentLog,
    );
    expect(result.attachmentIds).toEqual(["att-1", "att-2"]);
    expect(result.failedAttachmentNames).toEqual([]);
    expect(uploadAttachmentMock).toHaveBeenCalledTimes(2);

    // Maps email fields to the attachment-store upload shape.
    const firstCall = uploadAttachmentMock.mock.calls[0] as unknown[];
    expect(firstCall[1]).toEqual({
      filename: "a.pdf",
      mimeType: "application/pdf",
      data: att().content,
    });
  });

  it("skips oversized attachments by reported size", async () => {
    const result = await ingestEmailAttachments(
      config,
      [
        att({ filename: "small.pdf", size: 1000 }),
        att({ filename: "huge.pdf", size: 30 * 1024 * 1024 }),
      ],
      silentLog,
    );
    expect(result.attachmentIds).toEqual(["att-1"]);
    // Oversized is its own outcome: the notice names the cap instead of
    // asking for a re-send of a file that cannot get smaller.
    expect(result.failedAttachmentNames).toEqual([]);
    expect(result.oversizedAttachments).toEqual([
      { name: "huge.pdf", fileSize: 30 * 1024 * 1024, limit: 25 * 1024 * 1024 },
    ]);
    expect(uploadAttachmentMock).toHaveBeenCalledTimes(1);
  });

  it("skips validation-rejected attachments without dropping the rest", async () => {
    uploadAttachmentMock.mockImplementationOnce(() =>
      Promise.reject(new MockAttachmentValidationError("bad type")),
    );
    const result = await ingestEmailAttachments(
      config,
      [att({ filename: "bad.exe" }), att({ filename: "good.pdf" })],
      silentLog,
    );
    expect(result.attachmentIds).toEqual(["att-1"]);
    expect(result.failedAttachmentNames).toEqual(["bad.exe"]);
  });

  it("propagates transient upload failures so the caller can retry", async () => {
    uploadAttachmentMock.mockImplementation(() =>
      Promise.reject(new Error("upstream 503")),
    );
    await expect(
      ingestEmailAttachments(config, [att()], silentLog),
    ).rejects.toThrow("upstream 503");
  });

  it("falls back to the default cap when no email cap is configured", async () => {
    const noEmailCap = {
      maxAttachmentBytes: { default: 10 },
      maxAttachmentConcurrency: 3,
    } as unknown as GatewayConfig;
    const result = await ingestEmailAttachments(
      noEmailCap,
      [att({ filename: "over.pdf", size: 20 })],
      silentLog,
    );
    expect(result.attachmentIds).toEqual([]);
    expect(result.failedAttachmentNames).toEqual([]);
    expect(result.oversizedAttachments).toEqual([
      { name: "over.pdf", fileSize: 20, limit: 10 },
    ]);
  });
});

describe("appendFailedEmailAttachmentNotice", () => {
  const nothing = { failedAttachmentNames: [], oversizedAttachments: [] };

  it("returns content unchanged when nothing failed", () => {
    expect(appendFailedEmailAttachmentNotice("hello", nothing)).toBe("hello");
  });

  it("appends a notice listing failed attachments", () => {
    const out = appendFailedEmailAttachmentNotice("hello", {
      ...nothing,
      failedAttachmentNames: ["a.pdf", "b.png"],
    });
    expect(out).toContain("hello");
    expect(out).toContain('"a.pdf"');
    expect(out).toContain('"b.png"');
    expect(out).toContain("could not be processed");
  });

  it("uses the notice as the whole content when the body is empty", () => {
    const out = appendFailedEmailAttachmentNotice("", {
      ...nothing,
      failedAttachmentNames: ["a.pdf"],
    });
    expect(out.startsWith("[The user attached")).toBe(true);
  });

  it("names an oversized attachment with its size and the cap, in the shared words", () => {
    const out = appendFailedEmailAttachmentNotice("hello", {
      ...nothing,
      oversizedAttachments: [
        {
          name: "huge.pdf",
          fileSize: 30 * 1024 * 1024,
          limit: 25 * 1024 * 1024,
        },
      ],
    });
    expect(out).toBe(
      'hello\n\n[The user attached file(s) too large to receive: "huge.pdf" (30 MB, over the 25 MB limit). Re-sending the same file will not help; if the content is important, ask for a smaller version or a link.]',
    );
  });
});
