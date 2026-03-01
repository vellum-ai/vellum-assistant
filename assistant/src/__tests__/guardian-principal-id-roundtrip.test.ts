import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'guardian-principal-id-roundtrip-test-'));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  resolveCanonicalGuardianRequest,
  updateCanonicalGuardianRequest,
} from '../memory/canonical-guardian-store.js';
import {
  createBinding,
  getActiveBinding,
} from '../memory/guardian-bindings.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM canonical_guardian_deliveries');
  db.run('DELETE FROM canonical_guardian_requests');
  db.run('DELETE FROM channel_guardian_bindings');
}

describe('guardianPrincipalId roundtrip', () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ── channel_guardian_bindings ────────────────────────────────────────

  describe('channel_guardian_bindings', () => {
    test('creates binding with guardianPrincipalId and reads it back', () => {
      const binding = createBinding({
        assistantId: 'self',
        channel: 'telegram',
        guardianExternalUserId: 'tg-user-123',
        guardianDeliveryChatId: 'tg-chat-123',
        guardianPrincipalId: 'principal-abc-def',
      });

      expect(binding.guardianPrincipalId).toBe('principal-abc-def');

      const fetched = getActiveBinding('self', 'telegram');
      expect(fetched).not.toBeNull();
      expect(fetched!.guardianPrincipalId).toBe('principal-abc-def');
    });

    test('creates binding without guardianPrincipalId (defaults to null)', () => {
      const binding = createBinding({
        assistantId: 'self',
        channel: 'sms',
        guardianExternalUserId: 'sms-user-456',
        guardianDeliveryChatId: 'sms-chat-456',
      });

      expect(binding.guardianPrincipalId).toBeNull();

      const fetched = getActiveBinding('self', 'sms');
      expect(fetched).not.toBeNull();
      expect(fetched!.guardianPrincipalId).toBeNull();
    });
  });

  // ── canonical_guardian_requests ──────────────────────────────────────

  describe('canonical_guardian_requests', () => {
    test('creates request with guardianPrincipalId and reads it back', () => {
      const req = createCanonicalGuardianRequest({
        kind: 'tool_approval',
        sourceType: 'channel',
        sourceChannel: 'telegram',
        guardianExternalUserId: 'guardian-tg-1',
        guardianPrincipalId: 'principal-123',
      });

      expect(req.guardianPrincipalId).toBe('principal-123');
      expect(req.decidedByPrincipalId).toBeNull();

      const fetched = getCanonicalGuardianRequest(req.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.guardianPrincipalId).toBe('principal-123');
      expect(fetched!.decidedByPrincipalId).toBeNull();
    });

    test('creates request without guardianPrincipalId (defaults to null)', () => {
      const req = createCanonicalGuardianRequest({
        kind: 'access_request',
        sourceType: 'desktop',
      });

      expect(req.guardianPrincipalId).toBeNull();
      expect(req.decidedByPrincipalId).toBeNull();
    });

    test('creates request with decidedByPrincipalId', () => {
      const req = createCanonicalGuardianRequest({
        kind: 'tool_approval',
        sourceType: 'voice',
        decidedByPrincipalId: 'decider-principal-1',
      });

      expect(req.decidedByPrincipalId).toBe('decider-principal-1');
    });

    test('updates decidedByPrincipalId via updateCanonicalGuardianRequest', () => {
      const req = createCanonicalGuardianRequest({
        kind: 'tool_approval',
        sourceType: 'channel',
      });

      const updated = updateCanonicalGuardianRequest(req.id, {
        status: 'approved',
        decidedByPrincipalId: 'principal-decider-abc',
        decidedByExternalUserId: 'ext-user-1',
      });

      expect(updated).not.toBeNull();
      expect(updated!.decidedByPrincipalId).toBe('principal-decider-abc');
      expect(updated!.decidedByExternalUserId).toBe('ext-user-1');
      expect(updated!.status).toBe('approved');
    });

    test('resolveCanonicalGuardianRequest writes decidedByPrincipalId', () => {
      const req = createCanonicalGuardianRequest({
        kind: 'tool_approval',
        sourceType: 'voice',
        guardianPrincipalId: 'guardian-principal-xyz',
      });

      const resolved = resolveCanonicalGuardianRequest(req.id, 'pending', {
        status: 'approved',
        answerText: 'Approved',
        decidedByExternalUserId: 'guardian-ext-1',
        decidedByPrincipalId: 'guardian-principal-xyz',
      });

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe('approved');
      expect(resolved!.decidedByPrincipalId).toBe('guardian-principal-xyz');
      expect(resolved!.decidedByExternalUserId).toBe('guardian-ext-1');
      expect(resolved!.guardianPrincipalId).toBe('guardian-principal-xyz');
    });

    test('resolve without decidedByPrincipalId leaves it null', () => {
      const req = createCanonicalGuardianRequest({
        kind: 'tool_approval',
        sourceType: 'channel',
      });

      const resolved = resolveCanonicalGuardianRequest(req.id, 'pending', {
        status: 'denied',
        decidedByExternalUserId: 'guardian-ext-2',
      });

      expect(resolved).not.toBeNull();
      expect(resolved!.decidedByPrincipalId).toBeNull();
    });
  });
});
