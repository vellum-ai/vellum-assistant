/**
 * Shared test helper: stub `getConfig` from `../config/loader.js` for ACP tests.
 *
 * Bun's `mock.module` is process-global and only intercepts the literal keys
 * the factory returns. ACP test files have all been duplicating the same
 * mutable `mockAcpConfig` + `mock.module(..., () => ({ getConfig: ... }))`
 * boilerplate; this helper consolidates it. The real loader's other named
 * exports are spread into the mock so tests whose code path transitively
 * imports `loadConfig`, `invalidateConfigCache`, etc. don't fail at parse
 * time on "Export named 'X' not found".
 *
 * Like `which-stub.ts`, this is a process-global hook by design — Bun's
 * `mock.module` is process-global, so tests can't isolate it per-file.
 * Each test file should `await installAcpConfigStub()` once at the top
 * level and drive it via `setConfig(partial)` per test.
 */

import { mock } from "bun:test";

import type { AcpAgentConfig } from "../../../config/acp-schema.js";

export interface MockAcpConfig {
  enabled: boolean;
  maxConcurrentSessions: number;
  agents: Record<string, AcpAgentConfig>;
}

const DEFAULT_CONFIG: MockAcpConfig = {
  enabled: true,
  maxConcurrentSessions: 4,
  agents: {},
};

export interface AcpConfigStubHandle {
  setConfig(partial: Partial<MockAcpConfig>): void;
  getCurrent(): MockAcpConfig;
}

/**
 * Installs a process-global mock of `getConfig`. The real loader's named
 * exports are resolved *before* the mock registers so downstream dynamic
 * imports see the spread version — that's why this returns a Promise the
 * caller must `await`.
 */
export async function installAcpConfigStub(): Promise<AcpConfigStubHandle> {
  let mockAcpConfig: MockAcpConfig = { ...DEFAULT_CONFIG };
  const handle: AcpConfigStubHandle = {
    setConfig(partial) {
      mockAcpConfig = { ...DEFAULT_CONFIG, ...partial };
    },
    getCurrent() {
      return mockAcpConfig;
    },
  };

  const realLoader = await import("../../../config/loader.js");
  mock.module("../../../config/loader.js", () => ({
    ...realLoader,
    getConfig: () => ({ acp: mockAcpConfig }),
  }));
  return handle;
}
