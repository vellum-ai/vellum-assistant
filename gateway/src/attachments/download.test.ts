/**
 * Verifies streamed attachment response limits before MIME finalization.
 */
import { describe, expect, test } from "bun:test";

import { readLimitedAttachmentResponse } from "./download.js";
import { AttachmentTooLargeError } from "./ingest.js";

function streamedResponse(
  chunks: Uint8Array[],
  headers?: HeadersInit,
): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    { headers },
  );
}

describe("readLimitedAttachmentResponse", () => {
  test("rejects a streamed body beyond the limit without reading later chunks", async () => {
    let pulls = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(11));
            return;
          }
          controller.enqueue(new Uint8Array(11));
          controller.close();
        },
      }),
    );

    await expect(
      readLimitedAttachmentResponse(response, 10, "attachment-1"),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(pulls).toBe(1);
  });

  test("rejects an oversized Content-Length before reading the body", async () => {
    let pulls = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      }),
      { headers: { "Content-Length": "11" } },
    );
    await Promise.resolve();
    const pullsBeforeRead = pulls;

    await expect(
      readLimitedAttachmentResponse(response, 10, "attachment-1"),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(pulls).toBe(pullsBeforeRead);
  });

  test("accepts a body exactly at the limit", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await readLimitedAttachmentResponse(
      streamedResponse([bytes]),
      bytes.byteLength,
      "attachment-1",
    );

    expect(new Uint8Array(result)).toEqual(bytes);
  });
});
