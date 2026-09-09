/**
 * Every surface that draws attachment bytes (the transcript's inline image,
 * the message squares, the Chat Info tiles, the full-screen preview) fetches
 * through `fetchAttachmentContentBlob`, so the report it raises is the only
 * one any of them get.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import * as captureErrorModule from "@/lib/sentry/capture-error";
import * as daemonSdk from "@/generated/daemon/sdk.gen";
import { ApiError } from "@/utils/api-errors";

interface CapturedError {
  err: unknown;
  context?: string;
  bestEffort?: boolean;
}

let captured: CapturedError[] = [];
let contentResponse: () => Promise<{
  data: Blob | null | undefined;
  error: { message: string } | null;
  response?: Response;
}> = async () => ({ data: new Blob(["bytes"]), error: null });

const attachmentsByIdContentGet = mock(() => contentResponse());

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  attachmentsByIdContentGet,
}));

const saveFile = mock(
  async (_source: Blob | string, _filename: string): Promise<void> => undefined,
);
mock.module("@/runtime/native-file", () => ({ saveFile }));

mock.module("@/lib/sentry/capture-error", () => ({
  ...captureErrorModule,
  captureError: (
    err: unknown,
    options?: { context?: string; bestEffort?: boolean },
  ) => {
    captured.push({
      err,
      context: options?.context,
      bestEffort: options?.bestEffort,
    });
  },
}));

const { downloadAttachment, fetchAttachmentContentBlob } =
  await import("@/domains/chat/components/chat-attachments/download-attachment");
const { subscribe } = await import("@/lib/event-bus");

/** Terminal download reports the bus carried during the current test. */
let downloads: { filename: string; state: string }[] = [];
subscribe("download.done", (payload) => downloads.push(payload));

beforeEach(() => {
  captured = [];
  downloads = [];
  contentResponse = async () => ({ data: new Blob(["bytes"]), error: null });
});

afterEach(() => {
  attachmentsByIdContentGet.mockClear();
  saveFile.mockClear();
});

afterAll(() => {
  mock.restore();
});

describe("fetchAttachmentContentBlob", () => {
  test("reports a request that threw, and still answers null", async () => {
    const thrown = new Error("assistant offline");
    contentResponse = () => Promise.reject(thrown);

    expect(await fetchAttachmentContentBlob("asst-1", "att-1")).toBeNull();
    expect(captured).toEqual([
      {
        err: thrown,
        context: "fetchAttachmentContentBlob",
        bestEffort: true,
      },
    ]);
  });

  test("reports nothing for a request that answered", async () => {
    expect(await fetchAttachmentContentBlob("asst-1", "att-1")).toBeInstanceOf(
      Blob,
    );
    expect(captured).toEqual([]);
  });

  test("reports an error the request returned, and still answers null", async () => {
    const returned = { message: "boom" };
    contentResponse = async () => ({ data: undefined, error: returned });

    expect(await fetchAttachmentContentBlob("asst-1", "att-1")).toBeNull();
    expect(captured).toEqual([
      {
        err: returned,
        context: "fetchAttachmentContentBlob",
        bestEffort: true,
      },
    ]);
  });

  test("reports a returned HTTP failure with its status attached", async () => {
    contentResponse = async () => ({
      data: undefined,
      error: { message: "assistant starting" },
      response: new Response(null, { status: 503 }),
    });

    expect(await fetchAttachmentContentBlob("asst-1", "att-1")).toBeNull();
    expect(captured).toHaveLength(1);
    const [only] = captured;
    expect(only?.context).toBe("fetchAttachmentContentBlob");
    expect(only?.bestEffort).toBe(true);
    expect(only?.err).toBeInstanceOf(ApiError);
    expect((only?.err as ApiError).status).toBe(503);
  });

  test("answers null for a missing attachment without reporting it", async () => {
    contentResponse = async () => ({
      data: undefined,
      error: { message: "Attachment not found" },
      response: new Response(null, { status: 404 }),
    });

    expect(await fetchAttachmentContentBlob("asst-1", "att-gone")).toBeNull();
    expect(captured).toEqual([]);
  });

  test("never fetches, and never reports, for a synthetic history id", async () => {
    expect(
      await fetchAttachmentContentBlob("asst-1", "rehydrated:0"),
    ).toBeNull();
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
  });
});

describe("downloadAttachment", () => {
  test("reports an interrupted download when there are no bytes to save", async () => {
    // A deleted attachment answers 404, which the fetch reports as null rather
    // than an error, and it carries no inline preview to fall back to.
    contentResponse = async () => ({
      data: undefined,
      error: { message: "Attachment not found" },
      response: new Response(null, { status: 404 }),
    });

    await downloadAttachment(
      { id: "att-gone", filename: "gone.png", previewUrl: null },
      "asst-1",
    );

    expect(saveFile).not.toHaveBeenCalled();
    expect(downloads).toEqual([{ filename: "gone.png", state: "interrupted" }]);
  });

  test("stays quiet when the fetched bytes were saved", async () => {
    await downloadAttachment(
      { id: "att-1", filename: "photo.png", previewUrl: null },
      "asst-1",
    );

    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual([]);
  });

  test("stays quiet when the inline preview was saved", async () => {
    await downloadAttachment({
      id: "rehydrated:0",
      filename: "legacy.png",
      previewUrl: "data:image/png;base64,AAAA",
    });

    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual([]);
  });
});
