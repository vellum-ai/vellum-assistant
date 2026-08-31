/**
 * Tests for the pinned-artifact check that guards model downloads.
 *
 * The failure this prevents is silent: loading different weights does not
 * throw, it returns a well-formed 192-dim vector that simply is not
 * comparable to the embeddings already stored. So the check has to reject
 * a mismatch loudly, which is what these assert.
 *
 * The expectation is passed in, so these use small fixtures with known
 * digests rather than the 24.9 MB model.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { assertArtifactMatches } from "../embedder.js";

const CONTENT = "pinned artifact bytes";
const SHA256 = createHash("sha256").update(CONTENT).digest("hex");
const BYTES = Buffer.byteLength(CONTENT);

let dir: string;
let artifact: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "voiceprint-pin-"));
  artifact = join(dir, "model.onnx");
  await writeFile(artifact, CONTENT);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("assertArtifactMatches", () => {
  test("accepts the expected bytes", async () => {
    await expect(
      assertArtifactMatches(artifact, { bytes: BYTES, sha256: SHA256 }),
    ).resolves.toBeUndefined();
  });

  test("rejects a size mismatch", async () => {
    await expect(
      assertArtifactMatches(artifact, { bytes: BYTES + 1, sha256: SHA256 }),
    ).rejects.toThrow(/is \d+ bytes; expected/);
  });

  test("rejects a digest mismatch at the right size", async () => {
    // Same length, different content: only the digest can catch this, which
    // is the swapped-weights case.
    const swapped = join(dir, "swapped.onnx");
    const other = "PINNED ARTIFACT BYTES";
    expect(Buffer.byteLength(other)).toBe(BYTES);
    await writeFile(swapped, other);

    await expect(
      assertArtifactMatches(swapped, { bytes: BYTES, sha256: SHA256 }),
    ).rejects.toThrow(/has sha256 [0-9a-f]{64}; expected/);
  });

  test("rejects a missing file", async () => {
    await expect(
      assertArtifactMatches(join(dir, "absent.onnx"), {
        bytes: BYTES,
        sha256: SHA256,
      }),
    ).rejects.toThrow();
  });
});
