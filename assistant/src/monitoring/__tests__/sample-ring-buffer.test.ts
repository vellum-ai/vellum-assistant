/**
 * Tests for the on-disk sample ring buffer.
 *
 * The buffer is the resource monitor's crash-durable record, so the contract
 * that matters is: appends bound at capacity via rotation (not unbounded
 * growth), reads return chronological order across the rotation boundary, and a
 * half-written trailing line (as a SIGKILL would leave) is skipped rather than
 * throwing.
 */

import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SampleRingBuffer } from "../sample-ring-buffer.js";

let tmpDir: string;
let bufPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ring-buffer-test-"));
  bufPath = join(tmpDir, "samples.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SampleRingBuffer", () => {
  test("readRecent returns records oldest-first", () => {
    const buf = new SampleRingBuffer<{ n: number }>(bufPath, 100);
    for (let n = 0; n < 5; n++) buf.append({ n });
    expect(buf.readRecent().map((r) => r.n)).toEqual([0, 1, 2, 3, 4]);
    expect(buf.readLast()).toEqual({ n: 4 });
  });

  test("readRecent honours the limit, keeping the most recent", () => {
    const buf = new SampleRingBuffer<{ n: number }>(bufPath, 100);
    for (let n = 0; n < 10; n++) buf.append({ n });
    expect(buf.readRecent(3).map((r) => r.n)).toEqual([7, 8, 9]);
  });

  test("rotates at capacity and keeps history across the boundary", () => {
    // capacity 3: after 3 appends the active file rotates to <name>.1.
    const buf = new SampleRingBuffer<{ n: number }>(bufPath, 3);
    for (let n = 0; n < 5; n++) buf.append({ n });

    // Two files exist at most: active + rotated.
    const files = readdirSync(tmpDir).sort();
    expect(files).toEqual(["samples.jsonl", "samples.jsonl.1"]);

    // History spans the rotation: 0,1,2 in the rotated file, 3,4 in the active.
    expect(buf.readRecent().map((r) => r.n)).toEqual([0, 1, 2, 3, 4]);
    expect(buf.readLast()).toEqual({ n: 4 });
  });

  test("never keeps more than two files, bounding disk use", () => {
    const buf = new SampleRingBuffer<{ n: number }>(bufPath, 2);
    for (let n = 0; n < 20; n++) buf.append({ n });
    expect(readdirSync(tmpDir).length).toBeLessThanOrEqual(2);
    // The most recent record is always retained.
    expect(buf.readLast()).toEqual({ n: 19 });
  });

  test("skips a malformed trailing line (as a SIGKILL mid-write would leave)", () => {
    const buf = new SampleRingBuffer<{ n: number }>(bufPath, 100);
    buf.append({ n: 1 });
    // Simulate a half-written line with no trailing newline.
    appendFileSync(bufPath, '{"n":2,"partia');
    expect(buf.readRecent().map((r) => r.n)).toEqual([1]);
    expect(buf.readLast()).toEqual({ n: 1 });
  });

  test("resumes line accounting from an existing file so it still rotates", () => {
    const first = new SampleRingBuffer<{ n: number }>(bufPath, 3);
    first.append({ n: 0 });
    first.append({ n: 1 });

    // A fresh instance over the same path must count the two existing lines and
    // rotate on the next append rather than growing to 5.
    const second = new SampleRingBuffer<{ n: number }>(bufPath, 3);
    second.append({ n: 2 });
    second.append({ n: 3 });

    const files = readdirSync(tmpDir).sort();
    expect(files).toEqual(["samples.jsonl", "samples.jsonl.1"]);
    expect(second.readRecent().map((r) => r.n)).toEqual([0, 1, 2, 3]);
  });

  test("readLast returns null on an empty buffer", () => {
    const buf = new SampleRingBuffer<{ n: number }>(bufPath, 10);
    expect(buf.readLast()).toBeNull();
    expect(buf.readRecent()).toEqual([]);
  });
});
