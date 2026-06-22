import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockRouterResult: unknown;
let mockRouterError: Error | undefined;

const generateAvatarFn = mock(async () => {
  if (mockRouterError) throw mockRouterError;
  return mockRouterResult;
});

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../media/avatar-router.js", () => ({
  generateAvatar: generateAvatarFn,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Import after mocking
import { generateAvatarImage } from "../tools/system/avatar-generator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

function successResult() {
  return {
    imageBase64: PNG_BASE64,
    mimeType: "image/png",
  };
}

function executeAvatar(description: string) {
  return generateAvatarImage(description);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateAvatarImage", () => {
  beforeEach(() => {
    mockRouterResult = successResult();
    mockRouterError = undefined;
    generateAvatarFn.mockClear();
  });

  test("successful generation returns PNG bytes and success message", async () => {
    const result = await executeAvatar("a friendly purple cat");

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Avatar updated");
    expect(result.pngBuffer).toEqual(Buffer.from(PNG_BASE64, "base64"));
    expect(generateAvatarFn).toHaveBeenCalledTimes(1);
  });

  test("empty description returns error and no buffer", async () => {
    const result = await executeAvatar("");

    expect(result.isError).toBe(true);
    expect(result.pngBuffer).toBeNull();
    expect(result.content).toContain("description is required");
    expect(generateAvatarFn).not.toHaveBeenCalled();
  });

  test("no image data returned yields error", async () => {
    mockRouterResult = { ...successResult(), imageBase64: "" };

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.pngBuffer).toBeNull();
    expect(result.content).toContain("No image data returned");
  });

  test("router-mapped error message is surfaced verbatim", async () => {
    // avatar-router now maps provider errors before throwing, so the
    // generator just surfaces error.message directly.
    mockRouterError = new Error("Image generation failed: Network timeout");

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.pngBuffer).toBeNull();
    expect(result.content).toContain(
      "Image generation failed: Network timeout",
    );
  });
});
