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

interface CapturedError {
  err: unknown;
  context?: string;
  bestEffort?: boolean;
}

let captured: CapturedError[] = [];
let contentResponse: () => Promise<{
  data: Blob | null;
  error: { message: string } | null;
}> = async () => ({ data: new Blob(["bytes"]), error: null });

const attachmentsByIdContentGet = mock(() => contentResponse());

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  attachmentsByIdContentGet,
}));

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

const { fetchAttachmentContentBlob } =
  await import("@/domains/chat/components/chat-attachments/download-attachment");

beforeEach(() => {
  captured = [];
  contentResponse = async () => ({ data: new Blob(["bytes"]), error: null });
});

afterEach(() => {
  attachmentsByIdContentGet.mockClear();
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

  test("never fetches, and never reports, for a synthetic history id", async () => {
    expect(
      await fetchAttachmentContentBlob("asst-1", "rehydrated:0"),
    ).toBeNull();
    expect(attachmentsByIdContentGet).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
  });
});
