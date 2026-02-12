import { describe, test, expect } from "bun:test";
import { splitText } from "../telegram/send.js";

describe("splitText", () => {
  test("returns single chunk for short text", () => {
    const chunks = splitText("Hello!");
    expect(chunks).toEqual(["Hello!"]);
  });

  test("returns single chunk for exactly max length", () => {
    const text = "x".repeat(4000);
    const chunks = splitText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  test("splits text exceeding max length", () => {
    const text = "x".repeat(8500);
    const chunks = splitText(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(4000);
    expect(chunks[2]).toHaveLength(500);
    expect(chunks.join("")).toBe(text);
  });

  test("handles empty string", () => {
    const chunks = splitText("");
    expect(chunks).toEqual([""]);
  });
});
