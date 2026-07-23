import { describe, expect, test } from "bun:test";

import { DocumentPreviewSurfaceDataSchema } from "../api/surfaces.js";

describe("DocumentPreviewSurfaceDataSchema", () => {
  test("models the content/mimeType the client renderer reads", () => {
    const parsed = DocumentPreviewSurfaceDataSchema.parse({
      title: "Notes",
      surfaceId: "doc-real",
      subtitle: "Document",
      content: "# Heading\n\nbody",
      mimeType: "text/markdown",
    });

    expect(parsed).toEqual({
      title: "Notes",
      surfaceId: "doc-real",
      subtitle: "Document",
      content: "# Heading\n\nbody",
      mimeType: "text/markdown",
    });
  });

  test("content/mimeType are optional (a bare preview still parses)", () => {
    const parsed = DocumentPreviewSurfaceDataSchema.parse({
      title: "Notes",
      surfaceId: "doc-real",
    });

    expect(parsed.content).toBeUndefined();
    expect(parsed.mimeType).toBeUndefined();
  });
});
