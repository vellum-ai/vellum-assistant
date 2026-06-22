import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = path.join(os.tmpdir(), `device-id-test-${process.pid}`);
const DEVICE_FILE = path.join(TEST_DIR, "device.json");

// Stub @vellumai/local-mode so we control the resolved paths.
let mockEnvironment = "dev";
mock.module("@vellumai/local-mode", () => ({
  resolveConfigDir: () => TEST_DIR,
  resolveEnvironmentName: () => mockEnvironment,
}));

const { getDeviceId, resetDeviceIdCache } = await import("./device-id");

const cleanup = (): void => {
  resetDeviceIdCache();
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // already gone
  }
};

beforeEach(() => {
  cleanup();
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(cleanup);

describe("device-id", () => {
  test("reads existing device.json and returns the deviceId", () => {
    /**
     * Tests that when device.json already exists with a valid deviceId,
     * getDeviceId returns that value without overwriting it.
     */

    // GIVEN a device.json with a known UUID
    const existingId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    fs.writeFileSync(
      DEVICE_FILE,
      JSON.stringify({ deviceId: existingId }, null, 2) + "\n",
    );

    // WHEN getDeviceId is called
    const result = getDeviceId();

    // THEN it returns the existing ID
    expect(result).toBe(existingId);
  });

  test("creates device.json when the file does not exist", () => {
    /**
     * Tests that when no device.json exists, getDeviceId generates a new
     * UUID, writes it to disk, and returns it.
     */

    // GIVEN no device.json on disk
    expect(fs.existsSync(DEVICE_FILE)).toBe(false);

    // WHEN getDeviceId is called
    const result = getDeviceId();

    // THEN it returns a valid UUID
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // AND the file is created on disk with the same ID
    const onDisk = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf-8"));
    expect(onDisk.deviceId).toBe(result);
  });

  test("caches the result after the first call", () => {
    /**
     * Tests that subsequent calls return the same value without re-reading
     * disk. Verified by changing the file between calls.
     */

    // GIVEN getDeviceId has been called once
    const firstResult = getDeviceId();

    // WHEN the on-disk file is changed
    fs.writeFileSync(
      DEVICE_FILE,
      JSON.stringify({ deviceId: "changed-id" }, null, 2) + "\n",
    );

    // THEN the second call still returns the cached value
    expect(getDeviceId()).toBe(firstResult);
  });

  test("handles malformed JSON gracefully", () => {
    /**
     * Tests that a corrupted device.json doesn't crash the process — the
     * function generates a new UUID and overwrites the file.
     */

    // GIVEN a device.json with invalid JSON
    fs.writeFileSync(DEVICE_FILE, "not valid json {{{");

    // WHEN getDeviceId is called
    const result = getDeviceId();

    // THEN it returns a valid UUID
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // AND the file is overwritten with valid JSON
    const onDisk = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf-8"));
    expect(onDisk.deviceId).toBe(result);
  });

  test("handles device.json with missing deviceId field", () => {
    /**
     * Tests that a device.json without a deviceId field is treated the same
     * as a missing file — a new UUID is generated and the field is added
     * while preserving other content.
     */

    // GIVEN a device.json with other fields but no deviceId
    fs.writeFileSync(
      DEVICE_FILE,
      JSON.stringify({ otherField: "preserved" }, null, 2) + "\n",
    );

    // WHEN getDeviceId is called
    const result = getDeviceId();

    // THEN it returns a valid UUID
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // AND the existing field is preserved alongside the new deviceId
    const onDisk = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf-8"));
    expect(onDisk.deviceId).toBe(result);
    expect(onDisk.otherField).toBe("preserved");
  });

  test("resetDeviceIdCache forces re-read on next call", () => {
    /**
     * Tests that resetDeviceIdCache clears the in-memory cache so the next
     * getDeviceId call reads from disk again.
     */

    // GIVEN getDeviceId has been called and cached
    const firstResult = getDeviceId();

    // WHEN the cache is reset and the file is updated
    resetDeviceIdCache();
    const newId = "11111111-2222-3333-4444-555555555555";
    fs.writeFileSync(
      DEVICE_FILE,
      JSON.stringify({ deviceId: newId }, null, 2) + "\n",
    );

    // THEN the next call reads the new value from disk
    const secondResult = getDeviceId();
    expect(secondResult).toBe(newId);
    expect(secondResult).not.toBe(firstResult);
  });

  test("creates parent directories when they do not exist", () => {
    /**
     * Tests that getDeviceId creates the config directory tree if it
     * doesn't exist yet (first-run scenario).
     */

    // GIVEN the entire test directory has been removed
    fs.rmSync(TEST_DIR, { recursive: true, force: true });

    // WHEN getDeviceId is called
    const result = getDeviceId();

    // THEN it returns a valid UUID and the directory + file were created
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(fs.existsSync(DEVICE_FILE)).toBe(true);
  });
});
