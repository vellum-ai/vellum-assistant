import { describe, test, expect } from "bun:test";
import { win32 } from "node:path";

import {
  resolveRetiredFilePath,
  validateAssistantName,
} from "../lib/retire-archive.js";

describe("validateAssistantName", () => {
  test("accepts valid names", () => {
    expect(() => validateAssistantName("my-assistant")).not.toThrow();
    expect(() => validateAssistantName("test123")).not.toThrow();
    expect(() => validateAssistantName("a")).not.toThrow();
  });

  test("rejects empty string", () => {
    expect(() => validateAssistantName("")).toThrow("Invalid assistant name");
  });

  test("rejects names with forward slashes", () => {
    expect(() => validateAssistantName("foo/bar")).toThrow(
      "Invalid assistant name",
    );
  });

  test("rejects names with backslashes", () => {
    expect(() => validateAssistantName("foo\\bar")).toThrow(
      "Invalid assistant name",
    );
  });

  test("rejects dot-dot traversal", () => {
    expect(() => validateAssistantName("..")).toThrow("Invalid assistant name");
  });

  test("rejects single dot", () => {
    expect(() => validateAssistantName(".")).toThrow("Invalid assistant name");
  });
});

test("accepts a Windows archive path inside the retired directory", () => {
  const retiredDir = "C:\\Users\\Example User\\AppData\\Local\\Vellum\\retired";
  expect(
    resolveRetiredFilePath("assistant", "tar.gz", retiredDir, "win32"),
  ).toBe(win32.join(retiredDir, "assistant.tar.gz"));
});
