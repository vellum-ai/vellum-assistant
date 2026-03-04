import { describe, test, expect } from "bun:test";
import { validateAssistantName } from "../lib/retire-archive.js";

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
