import { describe, expect, test } from "bun:test";

import type {
  FileUploadSurfaceData,
  UiSurfaceShowFileUpload,
} from "../daemon/message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "../daemon/message-protocol.js";
import {
  requestFileTool,
  uiShowTool,
} from "../tools/ui-surface/definitions.js";

// ---------------------------------------------------------------------------
// request_file tool definition
// ---------------------------------------------------------------------------

describe("requestFileTool definition", () => {
  test("has the correct name and category", () => {
    expect(requestFileTool.name).toBe("request_file");
    expect(requestFileTool.category).toBe("ui-surface");
    expect(requestFileTool.executionMode).toBe("proxy");
  });

  test("getDefinition returns correct input_schema", () => {
    const definition = requestFileTool.getDefinition();

    expect(definition.name).toBe("request_file");
    expect(definition.description).toContain("file");

    const schema = definition.input_schema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["prompt"]);
    expect(schema.properties).toHaveProperty("prompt");
    expect(schema.properties).toHaveProperty("accepted_types");
    expect(schema.properties).toHaveProperty("max_files");
  });

  test("prompt property is a string type", () => {
    const definition = requestFileTool.getDefinition();
    const props = (
      definition.input_schema as {
        properties: Record<string, { type: string }>;
      }
    ).properties;

    expect(props.prompt.type).toBe("string");
  });

  test("accepted_types property is an array of strings", () => {
    const definition = requestFileTool.getDefinition();
    const props = (
      definition.input_schema as {
        properties: Record<string, { type: string; items?: { type: string } }>;
      }
    ).properties;

    expect(props.accepted_types.type).toBe("array");
    expect(props.accepted_types.items).toEqual({ type: "string" });
  });

  test("max_files property is a number type", () => {
    const definition = requestFileTool.getDefinition();
    const props = (
      definition.input_schema as {
        properties: Record<string, { type: string }>;
      }
    ).properties;

    expect(props.max_files.type).toBe("number");
  });

  test("execute throws proxy error", () => {
    expect(() => requestFileTool.execute({}, {} as never)).toThrow(
      "Proxy tool: execution must be forwarded to the connected client",
    );
  });
});

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
      sessionId: "session-abc",
      surfaceId: "surface-123",
      surfaceType: "file_upload",
      title: "File Request",
      data: { prompt: "Share a screenshot" },
    };

    expect(msg.type).toBe("ui_surface_show");
    expect(msg.surfaceType).toBe("file_upload");
    expect(msg.data.prompt).toBe("Share a screenshot");
    expect(msg.title).toBe("File Request");
    expect(msg.sessionId).toBe("session-abc");
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
    const definition = uiShowTool.getDefinition();
    const surfaceTypeEnum = (
      definition.input_schema as {
        properties: { surface_type: { enum: string[] } };
      }
    ).properties.surface_type.enum;

    expect(surfaceTypeEnum).toContain("file_upload");
  });

  test("description mentions file_upload", () => {
    const definition = uiShowTool.getDefinition();
    expect(definition.description).toContain("file_upload");
  });
});
