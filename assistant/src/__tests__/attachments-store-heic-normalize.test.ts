/**
 * Wiring tests for HEIF/HEIC storage normalization: user-sourced ingress
 * paths store a JPEG master (rewritten filename, mime, size, bytes) while
 * register and assistant-outbound paths keep content verbatim.
 *
 * The converter module is mocked (keyed on the declared mime type) so these
 * tests run identically with and without macOS sips; real conversion is
 * covered in image-conversion.test.ts. mock.module is process-global — keep
 * these cases in this file.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({}),
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getAssistantDomain: () => "vellum.me",
}));

const FAKE_JPEG = Buffer.from("fake-jpeg-master-bytes");
const FAKE_JPEG_B64 = FAKE_JPEG.toString("base64");

mock.module("../util/image-conversion.js", () => ({
  convertImageToJpeg: () => FAKE_JPEG,
  isHeifImage: (bytes: Uint8Array) => bytes.length >= 12,
  jpegFilenameFor: (filename: string) =>
    `${filename.replace(/\.[^./\\]+$/, "")}.jpg`,
  normalizeImageBytes: (mimeType: string, bytes: Uint8Array) =>
    mimeType === "image/heic"
      ? { mimeType: "image/jpeg", bytes: FAKE_JPEG, converted: true }
      : { mimeType, bytes, converted: false },
  normalizeImageBase64: (mimeType: string, dataBase64: string) =>
    mimeType === "image/heic"
      ? { mimeType: "image/jpeg", dataBase64: FAKE_JPEG_B64, converted: true }
      : { mimeType, dataBase64, converted: false },
}));

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachInlineAttachmentToMessage,
  getAttachmentById,
  getFilePathForAttachment,
  uploadAttachment,
  uploadAttachmentFromBytes,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  attachmentMetadataSchema,
  ROUTES,
} from "../runtime/routes/attachment-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import { getWorkspaceDir } from "../util/platform.js";
import { fakeHeifHeaderBytes } from "./heic-fixture.js";

const uploadRoute = ROUTES.find((r) => r.operationId === "attachment_upload")!;
const registerRoute = ROUTES.find(
  (r) => r.operationId === "attachment_register",
)!;

const HEIC_BYTES = fakeHeifHeaderBytes();
const HEIC_B64 = HEIC_BYTES.toString("base64");

function jsonUploadArgs(body: Record<string, unknown>): RouteHandlerArgs {
  return {
    body,
    rawBody: new TextEncoder().encode(JSON.stringify(body)),
    headers: { "content-type": "application/json" },
    queryParams: {},
  };
}

describe("HEIC upload normalization wiring", () => {
  beforeAll(async () => {
    await initializeDb();
  }, 30_000);

  test("uploadAttachmentFromBytes stores a JPEG master for HEIC", () => {
    const stored = uploadAttachmentFromBytes(
      "IMG_5487.HEIC",
      "image/heic",
      HEIC_BYTES,
    );

    expect(stored.originalFilename).toBe("IMG_5487.jpg");
    expect(stored.mimeType).toBe("image/jpeg");
    expect(stored.sizeBytes).toBe(FAKE_JPEG.length);
    const stagedPath = getFilePathForAttachment(stored.id);
    expect(stagedPath).not.toBeNull();
    expect(readFileSync(stagedPath!).equals(FAKE_JPEG)).toBe(true);
  });

  test("uploadAttachmentFromBytes leaves non-HEIC uploads verbatim", () => {
    const stored = uploadAttachmentFromBytes(
      "photo.png",
      "image/png",
      HEIC_BYTES,
    );

    expect(stored.originalFilename).toBe("photo.png");
    expect(stored.mimeType).toBe("image/png");
    expect(stored.sizeBytes).toBe(HEIC_BYTES.length);
  });

  test("uploadAttachment (base64) stores a JPEG master for HEIC", () => {
    const stored = uploadAttachment("IMG_1.heic", "image/heic", HEIC_B64);

    expect(stored.originalFilename).toBe("IMG_1.jpg");
    expect(stored.mimeType).toBe("image/jpeg");
    expect(stored.sizeBytes).toBe(FAKE_JPEG.length);
    const row = getAttachmentById(stored.id);
    expect(row?.dataBase64).toBe(FAKE_JPEG_B64);
  });

  test("uploadAttachment (base64) leaves non-HEIC uploads verbatim", () => {
    const stored = uploadAttachment("photo.png", "image/png", HEIC_B64);

    expect(stored.originalFilename).toBe("photo.png");
    expect(stored.mimeType).toBe("image/png");
    expect(stored.sizeBytes).toBe(HEIC_BYTES.length);
  });

  test("attachInlineAttachmentToMessage normalizes only when opted in", async () => {
    const conv = createConversation();
    const msg = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "photos" }]),
    );

    const normalized = attachInlineAttachmentToMessage(
      msg.id,
      0,
      "IMG_2.HEIC",
      "image/heic",
      HEIC_B64,
      { normalizeImage: true },
    );
    expect(normalized.originalFilename).toBe("IMG_2.jpg");
    expect(normalized.mimeType).toBe("image/jpeg");

    // Assistant-outbound attachments are stored verbatim: no normalizeImage
    // flag, no rewrite, even for HEIC content.
    const verbatim = attachInlineAttachmentToMessage(
      msg.id,
      1,
      "IMG_3.HEIC",
      "image/heic",
      HEIC_B64,
    );
    expect(verbatim.originalFilename).toBe("IMG_3.HEIC");
    expect(verbatim.mimeType).toBe("image/heic");
    expect(verbatim.sizeBytes).toBe(HEIC_BYTES.length);
  });

  test("JSON file-path upload converts the daemon-owned copy", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "vellum-heic-src-"));
    const sourcePath = join(sourceDir, "IMG_4.HEIC");
    writeFileSync(sourcePath, HEIC_BYTES);

    const raw = await uploadRoute.handler(
      jsonUploadArgs({
        filename: "IMG_4.HEIC",
        mimeType: "image/heic",
        filePath: sourcePath,
      }),
    );
    const result = attachmentMetadataSchema.parse(raw);

    expect(result.filename).toBe("IMG_4.jpg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.sizeBytes).toBe(FAKE_JPEG.length);
    // The caller's source file is never mutated.
    expect(readFileSync(sourcePath).equals(HEIC_BYTES)).toBe(true);
    // The staged raw copy is replaced by the converted one.
    const stagedPath = getFilePathForAttachment(result.id);
    expect(stagedPath).not.toBeNull();
    expect(stagedPath!.endsWith(".jpg")).toBe(true);
    expect(readFileSync(stagedPath!).equals(FAKE_JPEG)).toBe(true);
  });

  test("attachment register keeps workspace files verbatim", async () => {
    const registerDir = join(getWorkspaceDir(), "register-fixtures");
    mkdirSync(registerDir, { recursive: true });
    const registeredPath = join(registerDir, "IMG_5.HEIC");
    writeFileSync(registeredPath, HEIC_BYTES);

    const raw = await registerRoute.handler(
      jsonUploadArgs({
        path: registeredPath,
        mimeType: "image/heic",
        filename: "IMG_5.HEIC",
      }),
    );
    const result = raw as {
      originalFilename: string;
      mimeType: string;
    };

    expect(result.originalFilename).toBe("IMG_5.HEIC");
    expect(result.mimeType).toBe("image/heic");
    // Registered files are referenced in place, never rewritten.
    expect(existsSync(registeredPath)).toBe(true);
    expect(readFileSync(registeredPath).equals(HEIC_BYTES)).toBe(true);
  });
});
