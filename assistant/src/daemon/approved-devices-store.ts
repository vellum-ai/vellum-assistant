/**
 * Persistent store for always-allowed paired devices.
 *
 * Persisted to ~/.vellum/protected/approved-devices.json using the
 * atomic-write pattern from trust-store.ts (write .tmp → rename → chmod).
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getRootDir } from "../util/platform.js";

const log = getLogger("approved-devices-store");

export interface ApprovedDevice {
  hashedDeviceId: string;
  deviceName: string;
  lastPairedAt: number;
}

interface ApprovedDevicesFile {
  version: 1;
  devices: ApprovedDevice[];
}

function getStorePath(): string {
  return join(getRootDir(), "protected", "approved-devices.json");
}

/** Hash a raw deviceId for storage. */
export function hashDeviceId(deviceId: string): string {
  return createHash("sha256").update(deviceId).digest("hex");
}

let cachedDevices: Map<string, ApprovedDevice> | null = null;

function loadFromDisk(): Map<string, ApprovedDevice> {
  const path = getStorePath();
  if (!existsSync(path)) {
    return new Map();
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as ApprovedDevicesFile;
    if (data.version !== 1 || !Array.isArray(data.devices)) {
      log.warn("Invalid approved-devices.json format, starting fresh");
      return new Map();
    }
    const map = new Map<string, ApprovedDevice>();
    for (const device of data.devices) {
      map.set(device.hashedDeviceId, device);
    }
    return map;
  } catch (err) {
    log.error({ err }, "Failed to load approved-devices.json");
    return new Map();
  }
}

function saveToDisk(devices: Map<string, ApprovedDevice>): void {
  const path = getStorePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const data: ApprovedDevicesFile = {
    version: 1,
    devices: Array.from(devices.values()),
  };
  const tmpPath = path + ".tmp." + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
}

function getDevices(): Map<string, ApprovedDevice> {
  if (cachedDevices == null) {
    cachedDevices = loadFromDisk();
  }
  return cachedDevices;
}

/** Check if a hashed device ID is in the allowlist. */
export function isDeviceApproved(hashedDeviceId: string): boolean {
  return getDevices().has(hashedDeviceId);
}

/** Update lastPairedAt and deviceName for an existing device (auto-approve refresh). */
export function refreshDevice(
  hashedDeviceId: string,
  deviceName: string,
): void {
  const devices = getDevices();
  const existing = devices.get(hashedDeviceId);
  if (existing) {
    existing.deviceName = deviceName;
    existing.lastPairedAt = Date.now();
    saveToDisk(devices);
    log.info({ hashedDeviceId }, "Device metadata refreshed");
  }
}
