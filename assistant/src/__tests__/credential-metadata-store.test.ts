import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mock } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import {
  upsertCredentialMetadata,
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
  deleteCredentialMetadata,
  _setMetadataPath,
} from '../tools/credentials/metadata-store.js';

const TEST_DIR = join(tmpdir(), `vellum-credmeta-test-${randomBytes(4).toString('hex')}`);
const META_PATH = join(TEST_DIR, 'metadata.json');

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  _setMetadataPath(META_PATH);
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe('credential metadata store', () => {
  // ── Create ──────────────────────────────────────────────────────────

  describe('upsertCredentialMetadata', () => {
    test('creates new record with generated ID', () => {
      const record = upsertCredentialMetadata('github', 'token', {
        allowedTools: ['browser_fill_credential'],
        allowedDomains: ['github.com'],
        usageDescription: 'GitHub login',
      });

      expect(record.credentialId).toBeTruthy();
      expect(record.service).toBe('github');
      expect(record.field).toBe('token');
      expect(record.allowedTools).toEqual(['browser_fill_credential']);
      expect(record.allowedDomains).toEqual(['github.com']);
      expect(record.usageDescription).toBe('GitHub login');
      expect(record.createdAt).toBeGreaterThan(0);
      expect(record.updatedAt).toBe(record.createdAt);
    });

    test('defaults policy arrays to empty', () => {
      const record = upsertCredentialMetadata('gmail', 'password');
      expect(record.allowedTools).toEqual([]);
      expect(record.allowedDomains).toEqual([]);
      expect(record.usageDescription).toBeUndefined();
    });

    test('updates existing record by service+field', () => {
      const created = upsertCredentialMetadata('github', 'token', {
        allowedTools: ['browser_fill_credential'],
      });

      const updated = upsertCredentialMetadata('github', 'token', {
        allowedDomains: ['github.com'],
        usageDescription: 'Updated purpose',
      });

      expect(updated.credentialId).toBe(created.credentialId);
      expect(updated.allowedTools).toEqual(['browser_fill_credential']);
      expect(updated.allowedDomains).toEqual(['github.com']);
      expect(updated.usageDescription).toBe('Updated purpose');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.createdAt);
    });
  });

  // ── Read ────────────────────────────────────────────────────────────

  describe('getCredentialMetadata', () => {
    test('returns metadata by service+field', () => {
      upsertCredentialMetadata('github', 'token');
      const result = getCredentialMetadata('github', 'token');
      expect(result).toBeDefined();
      expect(result!.service).toBe('github');
    });

    test('returns undefined for non-existent credential', () => {
      expect(getCredentialMetadata('nonexistent', 'field')).toBeUndefined();
    });
  });

  describe('getCredentialMetadataById', () => {
    test('returns metadata by credentialId', () => {
      const created = upsertCredentialMetadata('github', 'token');
      const result = getCredentialMetadataById(created.credentialId);
      expect(result).toBeDefined();
      expect(result!.service).toBe('github');
    });

    test('returns undefined for non-existent ID', () => {
      expect(getCredentialMetadataById('non-existent-id')).toBeUndefined();
    });
  });

  // ── List ────────────────────────────────────────────────────────────

  describe('listCredentialMetadata', () => {
    test('returns all credentials', () => {
      upsertCredentialMetadata('github', 'token');
      upsertCredentialMetadata('gmail', 'password');
      const list = listCredentialMetadata();
      expect(list).toHaveLength(2);
    });

    test('returns empty array when no credentials exist', () => {
      expect(listCredentialMetadata()).toEqual([]);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────

  describe('deleteCredentialMetadata', () => {
    test('deletes existing metadata', () => {
      upsertCredentialMetadata('github', 'token');
      expect(deleteCredentialMetadata('github', 'token')).toBe(true);
      expect(getCredentialMetadata('github', 'token')).toBeUndefined();
    });

    test('returns false for non-existent credential', () => {
      expect(deleteCredentialMetadata('nonexistent', 'field')).toBe(false);
    });
  });

  // ── Persistence ─────────────────────────────────────────────────────

  describe('persistence', () => {
    test('metadata survives across calls (file-backed)', () => {
      upsertCredentialMetadata('github', 'token', {
        allowedTools: ['browser_fill_credential'],
      });

      // Read again (simulates new process reading same file)
      const result = getCredentialMetadata('github', 'token');
      expect(result).toBeDefined();
      expect(result!.allowedTools).toEqual(['browser_fill_credential']);
    });
  });

  // ── No secret values ───────────────────────────────────────────────

  describe('security', () => {
    test('metadata records never contain secret values', () => {
      const record = upsertCredentialMetadata('github', 'token', {
        allowedTools: ['browser_fill_credential'],
      });

      const keys = Object.keys(record);
      expect(keys).not.toContain('value');
      expect(keys).not.toContain('password');
      expect(JSON.stringify(record)).not.toContain('secret');
    });
  });
});
