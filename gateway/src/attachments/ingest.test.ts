import { describe, expect, test } from "bun:test";
import pino from "pino";
import type { GatewayConfig } from "../config.js";
import { appendFailedAttachmentNotice, ingestAttachments } from "./ingest.js";

const log = pino({ level: "silent" });

function config(overrides?: Partial<GatewayConfig>): GatewayConfig {
  const base: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 20,
      slack: 100,
      whatsapp: 16,
      discord: 100,
      default: 100,
    },
    maxAttachmentConcurrency: 2,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 1,
    runtimeMaxRetries: 0,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 1000,
    shutdownDrainMs: 1000,
    trustProxy: false,
  };
  return { ...base, ...overrides };
}

function attachment(fileId: string, fileSize?: number) {
  return {
    fileId,
    fileName: `${fileId}.txt`,
    ...(fileSize !== undefined ? { fileSize } : {}),
  };
}

const downloaded = {
  filename: "file.txt",
  mimeType: "text/plain",
  data: "ZmlsZQ==",
};

describe("ingestAttachments", () => {
  test("filters oversized attachments", async () => {
    const downloadedIds: string[] = [];
    const result = await ingestAttachments(
      config(),
      "telegram",
      [attachment("small", 10), attachment("large", 21)],
      log,
      {
        download: async (att) => {
          downloadedIds.push(att.fileId);
          return downloaded;
        },
        upload: async (att) => ({ id: att.filename }),
        failurePolicy: { mode: "skip" },
      },
    );

    expect(downloadedIds).toEqual(["small"]);
    expect(result.attachmentIds).toEqual(["file.txt"]);
  });

  test("bounds concurrent downloads", async () => {
    let active = 0;
    let maximum = 0;
    const result = await ingestAttachments(
      config({ maxAttachmentConcurrency: 2 }),
      "discord",
      [attachment("1"), attachment("2"), attachment("3"), attachment("4")],
      log,
      {
        download: async () => {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
          return downloaded;
        },
        upload: async () => ({ id: "uploaded" }),
        failurePolicy: { mode: "skip" },
      },
    );

    expect(maximum).toBe(2);
    expect(result.attachmentIds).toHaveLength(4);
  });

  test("skips classified errors and rethrows transient errors", async () => {
    const skipped = await ingestAttachments(
      config(),
      "telegram",
      [attachment("bad"), attachment("good")],
      log,
      {
        download: async (att) => {
          if (att.fileId === "bad") {
            throw new Error("validation");
          }
          return downloaded;
        },
        upload: async () => ({ id: "good-id" }),
        failurePolicy: {
          mode: "rethrow-unless-skippable",
          isSkippableError: (error) =>
            error instanceof Error && error.message === "validation",
        },
      },
    );
    expect(skipped).toEqual({
      attachmentIds: ["good-id"],
      failedAttachmentNames: ["bad.txt"],
    });

    await expect(
      ingestAttachments(config(), "telegram", [attachment("transient")], log, {
        download: async () => {
          throw new Error("transient");
        },
        upload: async () => ({ id: "unused" }),
        failurePolicy: {
          mode: "rethrow-unless-skippable",
          isSkippableError: () => false,
        },
      }),
    ).rejects.toThrow("transient");
  });
});

describe("appendFailedAttachmentNotice", () => {
  test("uses the notice as content for Slack's empty message path", () => {
    expect(appendFailedAttachmentNotice("", ["file.txt"])).toBe(
      '[The user attached file(s) that could not be retrieved: "file.txt". Ask them to re-send if the content is important.]',
    );
  });

  test("separates the notice from non-empty content", () => {
    expect(appendFailedAttachmentNotice("hello", ["file.txt"])).toBe(
      'hello\n\n[The user attached file(s) that could not be retrieved: "file.txt". Ask them to re-send if the content is important.]',
    );
  });
});
