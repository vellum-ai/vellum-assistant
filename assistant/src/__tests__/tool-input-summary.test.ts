import { describe, expect, test } from "bun:test";

import { summarizeToolInput } from "../tools/tool-input-summary.js";

describe("summarizeToolInput", () => {
  test("bash with short command returns full command", () => {
    expect(summarizeToolInput("bash", { command: "ls -la" })).toBe("ls -la");
  });

  test("bash with long command truncates with ellipsis", () => {
    const longCmd = "a".repeat(200);
    const result = summarizeToolInput("bash", { command: longCmd });
    expect(result.length).toBe(121); // 120 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
    expect(result.startsWith("a".repeat(120))).toBe(true);
  });

  test("terminal tool behaves like bash", () => {
    expect(summarizeToolInput("terminal", { command: "echo hello" })).toBe(
      "echo hello",
    );
  });

  test("file_read returns file path", () => {
    expect(
      summarizeToolInput("file_read", { file_path: "/src/index.ts" }),
    ).toBe("/src/index.ts");
  });

  test("file_write returns file path from path key", () => {
    expect(summarizeToolInput("file_write", { path: "/src/main.ts" })).toBe(
      "/src/main.ts",
    );
  });

  test("file_edit prefers file_path over path", () => {
    expect(
      summarizeToolInput("file_edit", {
        file_path: "/preferred.ts",
        path: "/fallback.ts",
      }),
    ).toBe("/preferred.ts");
  });

  test("web_fetch returns URL truncated to 100 chars", () => {
    const longUrl = `https://example.com/${"x".repeat(200)}`;
    const result = summarizeToolInput("web_fetch", { url: longUrl });
    expect(result.length).toBe(101); // 100 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });

  test("web_fetch with short URL returns full URL", () => {
    expect(
      summarizeToolInput("web_fetch", { url: "https://example.com" }),
    ).toBe("https://example.com");
  });

  test("network_request behaves like web_fetch", () => {
    expect(
      summarizeToolInput("network_request", { url: "https://api.test.com" }),
    ).toBe("https://api.test.com");
  });

  test("empty input returns empty string", () => {
    expect(summarizeToolInput("bash", {})).toBe("");
    expect(summarizeToolInput("file_read", {})).toBe("");
    expect(summarizeToolInput("web_fetch", {})).toBe("");
    expect(summarizeToolInput("unknown_tool", {})).toBe("");
  });

  test("unknown tool with string input returns first string value", () => {
    expect(
      summarizeToolInput("custom_tool", {
        query: "search for something",
        count: 10,
      }),
    ).toBe("search for something");
  });

  test("unknown tool with long string truncates to 80 chars", () => {
    const longVal = "b".repeat(150);
    const result = summarizeToolInput("custom_tool", { data: longVal });
    expect(result.length).toBe(81); // 80 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
  });

  test("input with no string values returns empty string", () => {
    expect(
      summarizeToolInput("custom_tool", { count: 42, flag: true, obj: {} }),
    ).toBe("");
  });

  test("whitespace-only string values are treated as empty", () => {
    expect(summarizeToolInput("bash", { command: "   " })).toBe("");
    expect(summarizeToolInput("custom_tool", { data: "  \n\t  " })).toBe("");
  });
});
