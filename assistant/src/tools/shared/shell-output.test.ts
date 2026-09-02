import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import {
  attachBoundedStdio,
  BoundedStdioCollector,
  formatShellOutput,
  MAX_OUTPUT_LENGTH,
  OUTPUT_TRUNCATED_TAG,
} from "./shell-output.js";

describe("BoundedStdioCollector", () => {
  test("keeps output under the cap", () => {
    const collector = new BoundedStdioCollector();
    collector.consume("stdout", Buffer.from("hello"));
    const result = collector.format(0, false, 120);
    expect(result.content).toBe("hello");
    expect(collector.didTruncate).toBe(false);
    expect(collector.keptByteLength).toBe(5);
  });

  test("caps a single oversized chunk without retaining the tail", () => {
    const collector = new BoundedStdioCollector();
    const huge = Buffer.alloc(MAX_OUTPUT_LENGTH + 50_000, 0x78);
    collector.consume("stdout", huge);
    huge.fill(0x79);
    expect(collector.keptByteLength).toBe(MAX_OUTPUT_LENGTH);
    expect(collector.didTruncate).toBe(true);
    const result = collector.format(0, false, 120);
    expect(result.content).toContain(OUTPUT_TRUNCATED_TAG);
    expect(result.content).not.toContain("file=");
    expect(result.content.startsWith("x".repeat(MAX_OUTPUT_LENGTH))).toBe(true);
    expect(result.content.length).toBeLessThan(MAX_OUTPUT_LENGTH + 80);
  });

  test("shares the budget across stdout and stderr", () => {
    const collector = new BoundedStdioCollector();
    collector.consume("stdout", Buffer.alloc(MAX_OUTPUT_LENGTH - 10, 0x61));
    collector.consume("stderr", Buffer.alloc(100, 0x62));
    expect(collector.keptByteLength).toBe(MAX_OUTPUT_LENGTH);
    expect(collector.didTruncate).toBe(true);
    const result = collector.format(0, false, 120);
    expect(result.content).toContain(OUTPUT_TRUNCATED_TAG);
    expect(result.content.includes("b")).toBe(true);
  });

  test("ignores chunks after the cap", () => {
    const collector = new BoundedStdioCollector();
    collector.consume("stdout", Buffer.alloc(MAX_OUTPUT_LENGTH, 0x78));
    const afterCap = collector.keptByteLength;
    collector.consume("stdout", Buffer.alloc(10_000, 0x79));
    collector.consume("stderr", Buffer.alloc(10_000, 0x7a));
    expect(collector.keptByteLength).toBe(afterCap);
    const result = collector.format(0, false, 120);
    expect(result.content).not.toContain("y");
    expect(result.content).not.toContain("z");
  });

  test("does not call onOutput for discarded bytes", () => {
    const seen: string[] = [];
    const collector = new BoundedStdioCollector();
    collector.consume("stdout", Buffer.from("abc"), (text) => seen.push(text));
    collector.consume("stdout", Buffer.alloc(MAX_OUTPUT_LENGTH, 0x78), (text) =>
      seen.push(text),
    );
    collector.consume("stdout", Buffer.from("TAIL"), (text) => seen.push(text));
    const forwarded = seen.join("");
    expect(forwarded).not.toContain("TAIL");
    expect(Buffer.byteLength(forwarded)).toBe(MAX_OUTPUT_LENGTH);
  });
});

describe("attachBoundedStdio", () => {
  test("drains further data events after the cap without growing kept bytes", () => {
    const child = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    };
    const collector = attachBoundedStdio(child);
    child.stdout.emit("data", Buffer.alloc(MAX_OUTPUT_LENGTH + 1000, 0x78));
    child.stdout.emit("data", Buffer.alloc(20_000, 0x79));
    child.stderr.emit("data", Buffer.alloc(20_000, 0x7a));
    expect(collector.keptByteLength).toBe(MAX_OUTPUT_LENGTH);
    expect(collector.didTruncate).toBe(true);
  });
});

describe("formatShellOutput truncation", () => {
  test("truncates an already-materialized oversized string without a file path", () => {
    const longOutput = "x".repeat(30_000);
    const result = formatShellOutput(longOutput, "", 0, false, 120);
    expect(result.content).toContain(OUTPUT_TRUNCATED_TAG);
    expect(result.content).not.toContain("file=");
    expect(result.content.length).toBeLessThan(MAX_OUTPUT_LENGTH + 80);
  });

  test("honors an explicit truncated flag at the exact cap", () => {
    const exact = "x".repeat(MAX_OUTPUT_LENGTH);
    const result = formatShellOutput(exact, "", 0, false, 120, {
      truncated: true,
    });
    expect(result.content).toContain(OUTPUT_TRUNCATED_TAG);
  });
});
