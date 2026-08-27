/**
 * Tests for the image-fallback plugin's `image_ask` tool and the
 * per-conversation image index it resolves filenames through.
 *
 * Images are seeded straight into the index over a real temp workspace, which
 * is the state the caption sweep leaves behind for one image (the sweep's own
 * write is covered in `image-fallback.test.ts`). Resolution, the workspace
 * boundary, and the answer path therefore run against files that really exist.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ConversationDeletedContext,
  ImageContent,
  ModelProfileInfo,
  ToolContext,
  ToolExecutionResult,
} from "@vellumai/plugin-api";

import { lastToolResultUserMessageIndex } from "../../../../context/outbound-sanitize.js";
// The risk-level enum is a real host value the tool imports through
// `@vellumai/plugin-api`; wire the shipped enum into the mock rather than a
// stand-in so the tool's declared band is the one the host would gate on.
import { RiskLevel } from "../../../../tools/tool-types.js";
import { isVisionNotSupportedError } from "../../../../util/provider-error-patterns.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A 1x1 PNG, small enough to inline and real enough to write to disk. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const WORKSPACE_DIR = mkdtempSync(join(tmpdir(), "image-ask-workspace-"));
const STORAGE_DIR = mkdtempSync(join(tmpdir(), "image-ask-store-"));
const ATTACHMENTS_DIR = join(WORKSPACE_DIR, "data", "attachments");

// ─── Mocks ──────────────────────────────────────────────────────────────────

let visionModels: Set<string>;
let visionProfiles: Set<string>;
let mockProfiles: ModelProfileInfo[];
let providerResponse: { content: Array<{ type: string; text?: string }> };
let providerThrows: Error | null;
let providerCalls: Array<{ systemPrompt?: string; config?: unknown }>;

const fakeProvider = {
  name: "mock-vision-provider",
  async sendMessage(
    _messages: unknown,
    options: { systemPrompt?: string; config?: unknown },
  ) {
    providerCalls.push({
      systemPrompt: options.systemPrompt,
      config: options.config,
    });
    if (providerThrows != null) {
      throw providerThrows;
    }
    return providerResponse;
  },
};

// The module registry is process-wide, so this surface covers every plugin-api
// export the plugin's tool and hooks import, not only the ones this file
// exercises.
mock.module("@vellumai/plugin-api", () => ({
  doesSupportVision: (arg: ModelProfileInfo | string) =>
    typeof arg === "string"
      ? visionModels.has(arg)
      : visionProfiles.has(arg.key),
  getModelProfiles: () => mockProfiles,
  getWorkspaceDir: () => WORKSPACE_DIR,
  getAttachmentFilePath: () => null,
  resolveMediaSourceData: (source: ImageContent["source"]) =>
    source.type === "base64"
      ? { data: source.data, media_type: source.media_type }
      : null,
  getConfiguredProvider: async () => fakeProvider,
  persistSystemCard: async () => "card-1",
  lastToolResultUserMessageIndex,
  isVisionNotSupportedError,
  RiskLevel,
}));

// ─── Imports (after mocks are registered) ───────────────────────────────────

const imageAsk = (await import("../tools/image_ask.js")).default;
const conversationDeleted = (await import("../hooks/conversation-deleted.js"))
  .default;
const { closeCaptionStore, initCaptionStore, resetCaptionCacheForTests } =
  await import("../src/caption-cache.js");
const {
  initImageIndex,
  listConversationImages,
  recordConversationImage,
  resetImageIndexForTests,
} = await import("../src/image-index.js");

initCaptionStore(STORAGE_DIR);
initImageIndex();

afterAll(() => {
  closeCaptionStore();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  rmSync(WORKSPACE_DIR, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Write an image into the workspace and index it for `conversationId`, the
 * state the caption sweep leaves behind for one image. Returns its path.
 */
function seedImage(conversationId: string, filename: string): string {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const filePath = join(ATTACHMENTS_DIR, filename);
  writeFileSync(filePath, Buffer.from(PNG_BASE64, "base64"));
  recordConversationImage(conversationId, filePath, "image/png", filename);
  return filePath;
}

async function ask(
  conversationId: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return imageAsk.execute(input, {
    conversationId,
    workingDir: WORKSPACE_DIR,
  } as ToolContext);
}

beforeEach(() => {
  visionModels = new Set(["vision-model"]);
  visionProfiles = new Set(["vision-profile"]);
  mockProfiles = [
    { key: "vision-profile", isDisabled: false } as unknown as ModelProfileInfo,
  ];
  providerResponse = { content: [{ type: "text", text: "The total is 42." }] };
  providerThrows = null;
  providerCalls = [];
  resetCaptionCacheForTests();
  resetImageIndexForTests();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("image-fallback image index", () => {
  test("keeps one row per image and reports the newest first", () => {
    seedImage("c-index", "first.png");
    seedImage("c-index", "second.png");
    seedImage("c-index", "first.png");

    const images = listConversationImages("c-index");
    expect(images).toHaveLength(2);
    expect(images[0].filePath.endsWith("second.png")).toBe(true);
    expect(images[0].mediaType).toBe("image/png");
  });

  test("conversation-deleted purges only that conversation's rows", async () => {
    seedImage("c-doomed", "doomed.png");
    seedImage("c-kept", "kept.png");

    await conversationDeleted({
      conversationId: "c-doomed",
      logger: noopLogger,
    } as unknown as ConversationDeletedContext);

    expect(listConversationImages("c-doomed")).toHaveLength(0);
    expect(listConversationImages("c-kept")).toHaveLength(1);
  });
});

describe("image_ask activation", () => {
  test("is off for a model that can see images itself", () => {
    expect(imageAsk.isActive({ model: "vision-model" })).toBe(false);
  });

  test("is on for a text-only model", () => {
    expect(imageAsk.isActive({ model: "text-only-model" })).toBe(true);
  });

  test("is on outside a turn, where no model is resolved", () => {
    expect(imageAsk.isActive({ model: "" })).toBe(true);
  });
});

describe("image_ask resolution", () => {
  test("uses the most recent image when none is named", async () => {
    seedImage("c-ask", "older.png");
    seedImage("c-ask", "newer.png");

    const result = await ask("c-ask", { question: "What is the total?" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("newer.png");
    expect(result.content).toContain("The total is 42.");
  });

  test("resolves an image by filename", async () => {
    seedImage("c-name", "older.png");
    seedImage("c-name", "newer.png");

    const result = await ask("c-name", {
      question: "What is the total?",
      image: "older.png",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("older.png");
  });

  test("resolves an image by its stored path", async () => {
    const filePath = seedImage("c-path", "chart.png");

    const result = await ask("c-path", {
      question: "What is the total?",
      image: filePath,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("chart.png");
  });

  test("lists the known filenames when the named image is unknown", async () => {
    seedImage("c-unknown", "chart.png");

    const result = await ask("c-unknown", {
      question: "What is the total?",
      image: "not-here.png",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not-here.png");
    expect(result.content).toContain("chart.png");
    expect(providerCalls).toHaveLength(0);
  });

  test("reports when the conversation has no images", async () => {
    const result = await ask("c-empty", { question: "What is the total?" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No images");
    expect(providerCalls).toHaveLength(0);
  });

  test("rejects an image stored outside the workspace", async () => {
    recordConversationImage("c-outside", "/etc/passwd", "image/png", "hash");

    const result = await ask("c-outside", { question: "What is in it?" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the workspace");
    expect(providerCalls).toHaveLength(0);
  });

  test("reports an image whose file is gone", async () => {
    const filePath = seedImage("c-gone", "gone.png");
    unlinkSync(filePath);

    const result = await ask("c-gone", { question: "What is the total?" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no longer readable");
    expect(providerCalls).toHaveLength(0);
  });
});

describe("image_ask answers", () => {
  test("requires a question", async () => {
    seedImage("c-noq", "chart.png");

    const result = await ask("c-noq", { question: "   " });

    expect(result.isError).toBe(true);
    expect(providerCalls).toHaveLength(0);
  });

  test("sends the question to the vision call site under a vision profile", async () => {
    seedImage("c-send", "chart.png");

    await ask("c-send", { question: "What is the exact total?" });

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].systemPrompt).toContain(
      "only from what is visible",
    );
    const config = providerCalls[0].config as {
      callSite: string;
      overrideProfile: string;
    };
    expect(config.callSite).toBe("vision");
    expect(config.overrideProfile).toBe("vision-profile");
  });

  test("returns text only, never an image block", async () => {
    seedImage("c-text", "chart.png");

    const result = await ask("c-text", { question: "What is the total?" });

    expect(result.contentBlocks).toBeUndefined();
    expect(typeof result.content).toBe("string");
  });

  test("flags an answer the image does not show", async () => {
    seedImage("c-unseen", "chart.png");
    providerResponse = {
      content: [
        {
          type: "text",
          text: "NOT_VISIBLE: the bottom of the table is cut off.",
        },
      ],
    };

    const result = await ask("c-unseen", { question: "What is the total?" });

    expect(result.isError).toBe(false);
    expect(result.status).toBe("not in image");
    expect(result.content).toContain("does not show the answer");
    expect(result.content).toContain("cut off");
    expect(result.content).not.toContain("NOT_VISIBLE");
  });

  test("reports a failed vision call without throwing", async () => {
    seedImage("c-fail", "chart.png");
    providerThrows = new Error("upstream is down");

    const result = await ask("c-fail", { question: "What is the total?" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not get an answer");
  });

  test("reports an empty vision response", async () => {
    seedImage("c-blank", "chart.png");
    providerResponse = { content: [] };

    const result = await ask("c-blank", { question: "What is the total?" });

    expect(result.isError).toBe(true);
  });

  test("reports when no vision-capable profile is configured", async () => {
    seedImage("c-noprofile", "chart.png");
    mockProfiles = [];

    const result = await ask("c-noprofile", { question: "What is the total?" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No vision-capable model");
    expect(providerCalls).toHaveLength(0);
  });
});

describe("image_ask definition", () => {
  test("declares the low risk band and a required question", () => {
    expect(imageAsk.defaultRiskLevel).toBe(RiskLevel.Low);
    expect((imageAsk.input_schema as { required: string[] }).required).toEqual([
      "question",
    ]);
  });

  test("tells the model the answerer has no conversation context", () => {
    expect(imageAsk.description).toContain("no conversation");
    expect(imageAsk.description).toContain("self-contained");
  });
});
