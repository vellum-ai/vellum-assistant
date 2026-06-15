/**
 * Tests for the structured tools breakdown on the Prompt tab. Renders to
 * static markup (no DOM), mirroring `call-rail.test.tsx`, and asserts tool
 * names, schema properties, and server-tool settings appear without raw
 * JSON dumps.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolDefinitionsContent } from "./tool-definitions-content";

describe("ToolDefinitionsContent", () => {
  test("lists tools by name with schema property breakdown", () => {
    const html = renderToStaticMarkup(
      <ToolDefinitionsContent
        tools={[
          {
            name: "file_read",
            type: null,
            description: "Read a file from the workspace.",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string", description: "Workspace path." },
                mode: { type: "string", enum: ["text", "binary"] },
              },
              required: ["path"],
            },
            extras: {},
          },
        ]}
      />,
    );

    expect(html).toContain("1 tool sent with this request");
    expect(html).toContain("file_read");
    expect(html).toContain("Read a file from the workspace.");
    expect(html).toContain("path");
    expect(html).toContain("required");
    expect(html).toContain("Workspace path.");
    expect(html).toContain("&quot;text&quot; | &quot;binary&quot;");
    // No raw JSON dump — braces from a stringified payload must not appear.
    expect(html).not.toContain("input_schema");
  });

  test("renders server tools with type tag and settings", () => {
    const html = renderToStaticMarkup(
      <ToolDefinitionsContent
        tools={[
          {
            name: "web_search",
            type: "web_search_20250305",
            description: null,
            inputSchema: null,
            extras: { max_uses: 8 },
          },
        ]}
      />,
    );

    expect(html).toContain("web_search");
    expect(html).toContain("web_search_20250305");
    expect(html).toContain("max_uses");
    expect(html).toContain("8");
    expect(html).toContain("No input schema");
  });
});
