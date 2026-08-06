import { describe, expect, test } from "bun:test";

import { FileUploadSurfaceDataSchema } from "../api/surfaces.js";
import type {
  FileUploadSurfaceData,
  UiSurfaceShowFileUpload,
} from "../daemon/message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "../daemon/message-protocol.js";
import { explicitTools } from "../tools/tool-manifest.js";
import { uiShowTool } from "../tools/ui-surface/definitions.js";

// ---------------------------------------------------------------------------
// FileUploadSurfaceData shape
// ---------------------------------------------------------------------------

describe("FileUploadSurfaceData shape", () => {
  test("accepts an object with prompt, acceptedTypes, and maxFiles", () => {
    const data: FileUploadSurfaceData = {
      prompt: "Please share the design file",
      acceptedTypes: ["image/*", "application/pdf"],
      maxFiles: 3,
    };

    expect(data.prompt).toBe("Please share the design file");
    expect(data.acceptedTypes).toEqual(["image/*", "application/pdf"]);
    expect(data.maxFiles).toBe(3);
  });

  test("acceptedTypes and maxFiles are optional", () => {
    const data: FileUploadSurfaceData = {
      prompt: "Upload a file",
    };

    expect(data.prompt).toBe("Upload a file");
    expect(data.acceptedTypes).toBeUndefined();
    expect(data.maxFiles).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UiSurfaceShowFileUpload structure
// ---------------------------------------------------------------------------

describe("UiSurfaceShowFileUpload structure", () => {
  test("can construct a well-typed UiSurfaceShowFileUpload object", () => {
    const msg: UiSurfaceShowFileUpload = {
      type: "ui_surface_show",
      conversationId: "session-abc",
      surfaceId: "surface-123",
      surfaceType: "file_upload",
      title: "File Request",
      data: { prompt: "Share a screenshot" },
    };

    expect(msg.type).toBe("ui_surface_show");
    expect(msg.surfaceType).toBe("file_upload");
    expect(msg.data.prompt).toBe("Share a screenshot");
    expect(msg.title).toBe("File Request");
    expect(msg.conversationId).toBe("session-abc");
    expect(msg.surfaceId).toBe("surface-123");
  });
});

// ---------------------------------------------------------------------------
// Interactivity
// ---------------------------------------------------------------------------

describe("file_upload interactivity", () => {
  test("file_upload is in the interactive surface types list", () => {
    expect(INTERACTIVE_SURFACE_TYPES).toContain("file_upload");
  });
});

// ---------------------------------------------------------------------------
// ui_show tool includes file_upload in surface_type enum
// ---------------------------------------------------------------------------

describe("ui_show tool includes file_upload", () => {
  test("input_schema surface_type enum includes file_upload", () => {
    const definition = uiShowTool;
    const surfaceTypeEnum = (
      definition.input_schema as {
        properties: { surface_type: { enum: string[] } };
      }
    ).properties.surface_type.enum;

    expect(surfaceTypeEnum).toContain("file_upload");
  });

  test("description mentions file_upload", () => {
    const definition = uiShowTool;
    expect(definition.description).toContain("file_upload");
  });
});

describe("UI surface tool registration", () => {
  test("registers only the base UI surface tools", () => {
    const uiToolNames = explicitTools
      .map((tool) => tool.name)
      .filter((name) => name?.startsWith("ui_"));
    expect(uiToolNames).toEqual(["ui_show", "ui_update", "ui_dismiss"]);
  });
});

// ---------------------------------------------------------------------------
// FileUploadSurfaceDataSchema coercion
// ---------------------------------------------------------------------------
//
// `acceptedTypes` is contractually a string[], but the model frequently emits a
// comma-joined string or a bare string. The renderer calls `.join`/`.some` on
// it, so the schema coerces every shape to the array contract.

describe("FileUploadSurfaceDataSchema coercion", () => {
  test("passes a well-formed payload through unchanged", () => {
    expect(
      FileUploadSurfaceDataSchema.parse({
        prompt: "Share the receipt PDF",
        acceptedTypes: ["image/*", "application/pdf"],
        maxFiles: 3,
      }),
    ).toEqual({
      prompt: "Share the receipt PDF",
      acceptedTypes: ["image/*", "application/pdf"],
      maxFiles: 3,
    });
  });

  test("coerces a comma-joined acceptedTypes string into an array", () => {
    expect(
      FileUploadSurfaceDataSchema.parse({
        prompt: "p",
        acceptedTypes: "image/*, application/pdf",
      }).acceptedTypes,
    ).toEqual(["image/*", "application/pdf"]);
  });

  test("wraps a single acceptedTypes string into a one-element array", () => {
    expect(
      FileUploadSurfaceDataSchema.parse({ acceptedTypes: "application/pdf" })
        .acceptedTypes,
    ).toEqual(["application/pdf"]);
  });

  test("the parsed acceptedTypes always supports .join", () => {
    const parsed = FileUploadSurfaceDataSchema.parse({
      acceptedTypes: "image/*,application/pdf",
    });
    // `.join` is the call the renderer makes on `acceptedTypes`.
    expect(parsed.acceptedTypes?.join(",")).toBe("image/*,application/pdf");
  });

  test("drops blanks and non-string entries from an array", () => {
    expect(
      FileUploadSurfaceDataSchema.parse({
        acceptedTypes: [" application/pdf ", "", null, 42, {}],
      }).acceptedTypes,
    ).toEqual(["application/pdf", "42"]);
  });

  test("treats a non-string, non-array acceptedTypes as absent", () => {
    expect(
      FileUploadSurfaceDataSchema.parse({ acceptedTypes: { pdf: true } })
        .acceptedTypes,
    ).toBeUndefined();
    expect(
      FileUploadSurfaceDataSchema.parse({ acceptedTypes: null }).acceptedTypes,
    ).toBeUndefined();
  });

  test("coerces numeric-string maxFiles and drops invalid numbers", () => {
    const parsed = FileUploadSurfaceDataSchema.parse({
      maxFiles: "2",
      maxSizeBytes: "not-a-number",
    });
    expect(parsed.maxFiles).toBe(2);
    expect(parsed.maxSizeBytes).toBeUndefined();
  });

  test("never rejects a fully malformed payload", () => {
    expect(
      FileUploadSurfaceDataSchema.safeParse({
        prompt: 5,
        acceptedTypes: 99,
        maxFiles: -1,
      }).success,
    ).toBe(true);
  });
});
