import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
  assertMetadataWritable,
  _setMetadataPath,
} from '../tools/credentials/metadata-store.js';

import type { CredentialInjectionTemplate } from '../tools/credentials/policy-types.js';

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

  // ── v2 Schema: alias + injectionTemplates ──────────────────────────

  describe('v2 schema — alias and injectionTemplates', () => {
    const falInjection: CredentialInjectionTemplate = {
      hostPattern: '*.fal.ai',
      injectionType: 'header',
      headerName: 'Authorization',
      valuePrefix: 'Key ',
    };

    const queryInjection: CredentialInjectionTemplate = {
      hostPattern: 'maps.example.com',
      injectionType: 'query',
      queryParamName: 'key',
    };

    test('creates record with alias', () => {
      const record = upsertCredentialMetadata('fal-ai', 'api_key', {
        alias: 'fal-primary',
        allowedTools: ['api_request'],
      });
      expect(record.alias).toBe('fal-primary');
    });

    test('creates record with injectionTemplates', () => {
      const record = upsertCredentialMetadata('fal-ai', 'api_key', {
        injectionTemplates: [falInjection],
      });
      expect(record.injectionTemplates).toEqual([falInjection]);
    });

    test('creates record with multiple injection templates', () => {
      const record = upsertCredentialMetadata('multi', 'key', {
        injectionTemplates: [falInjection, queryInjection],
      });
      expect(record.injectionTemplates).toHaveLength(2);
      expect(record.injectionTemplates![0].injectionType).toBe('header');
      expect(record.injectionTemplates![1].injectionType).toBe('query');
    });

    test('creates record with alias and injectionTemplates together', () => {
      const record = upsertCredentialMetadata('fal-ai', 'api_key', {
        alias: 'fal-primary',
        allowedDomains: ['fal.ai'],
        injectionTemplates: [falInjection],
      });
      expect(record.alias).toBe('fal-primary');
      expect(record.injectionTemplates).toEqual([falInjection]);
      expect(record.allowedDomains).toEqual(['fal.ai']);
    });

    test('defaults alias and injectionTemplates to undefined when not provided', () => {
      const record = upsertCredentialMetadata('basic', 'token');
      expect(record.alias).toBeUndefined();
      expect(record.injectionTemplates).toBeUndefined();
    });

    test('updates alias on existing record', () => {
      upsertCredentialMetadata('fal-ai', 'api_key', { alias: 'fal-old' });
      const updated = upsertCredentialMetadata('fal-ai', 'api_key', { alias: 'fal-new' });
      expect(updated.alias).toBe('fal-new');
    });

    test('clears alias with null', () => {
      upsertCredentialMetadata('fal-ai', 'api_key', { alias: 'fal-primary' });
      const updated = upsertCredentialMetadata('fal-ai', 'api_key', { alias: null });
      expect(updated.alias).toBeUndefined();
    });

    test('updates injectionTemplates on existing record', () => {
      upsertCredentialMetadata('fal-ai', 'api_key', { injectionTemplates: [falInjection] });
      const updated = upsertCredentialMetadata('fal-ai', 'api_key', { injectionTemplates: [queryInjection] });
      expect(updated.injectionTemplates).toEqual([queryInjection]);
    });

    test('clears injectionTemplates with null', () => {
      upsertCredentialMetadata('fal-ai', 'api_key', { injectionTemplates: [falInjection] });
      const updated = upsertCredentialMetadata('fal-ai', 'api_key', { injectionTemplates: null });
      expect(updated.injectionTemplates).toBeUndefined();
    });

    test('round-trip: alias and templates survive serialization', () => {
      upsertCredentialMetadata('fal-ai', 'api_key', {
        alias: 'fal-primary',
        allowedTools: ['api_request'],
        allowedDomains: ['fal.ai'],
        injectionTemplates: [falInjection],
      });

      // Re-read from disk
      const loaded = getCredentialMetadata('fal-ai', 'api_key');
      expect(loaded).toBeDefined();
      expect(loaded!.alias).toBe('fal-primary');
      expect(loaded!.injectionTemplates).toEqual([falInjection]);
      expect(loaded!.allowedTools).toEqual(['api_request']);
    });
  });

  // ── Version migration ──────────────────────────────────────────────

  describe('version migration', () => {
    test('v1 file is migrated: records get undefined alias and injectionTemplates', () => {
      // Write a v1-format file directly
      const v1Data = {
        version: 1,
        credentials: [
          {
            credentialId: 'cred-legacy-001',
            service: 'github',
            field: 'token',
            allowedTools: ['browser_fill_credential'],
            allowedDomains: ['github.com'],
            usageDescription: 'Legacy GitHub token',
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
          },
        ],
      };
      writeFileSync(META_PATH, JSON.stringify(v1Data, null, 2), 'utf-8');

      const records = listCredentialMetadata();
      expect(records).toHaveLength(1);
      expect(records[0].credentialId).toBe('cred-legacy-001');
      expect(records[0].service).toBe('github');
      expect(records[0].alias).toBeUndefined();
      expect(records[0].injectionTemplates).toBeUndefined();
      // Original fields preserved
      expect(records[0].allowedTools).toEqual(['browser_fill_credential']);
      expect(records[0].usageDescription).toBe('Legacy GitHub token');
    });

    test('v1 file with no version field is treated as v1 and migrated', () => {
      const noVersionData = {
        credentials: [
          {
            credentialId: 'cred-noversion',
            service: 'slack',
            field: 'token',
            allowedTools: [],
            allowedDomains: [],
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
          },
        ],
      };
      writeFileSync(META_PATH, JSON.stringify(noVersionData, null, 2), 'utf-8');

      const records = listCredentialMetadata();
      expect(records).toHaveLength(1);
      expect(records[0].alias).toBeUndefined();
      expect(records[0].injectionTemplates).toBeUndefined();
    });

    test('v1 migration preserves credentialId as primary identifier', () => {
      const v1Data = {
        version: 1,
        credentials: [
          {
            credentialId: 'cred-stable-id',
            service: 'myservice',
            field: 'key',
            allowedTools: [],
            allowedDomains: [],
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
          },
        ],
      };
      writeFileSync(META_PATH, JSON.stringify(v1Data, null, 2), 'utf-8');

      const record = getCredentialMetadataById('cred-stable-id');
      expect(record).toBeDefined();
      expect(record!.credentialId).toBe('cred-stable-id');
    });

    test('v2 file is loaded without migration', () => {
      const v2Data = {
        version: 2,
        credentials: [
          {
            credentialId: 'cred-v2-001',
            service: 'fal-ai',
            field: 'api_key',
            allowedTools: ['api_request'],
            allowedDomains: ['fal.ai'],
            alias: 'fal-primary',
            injectionTemplates: [
              {
                hostPattern: '*.fal.ai',
                injectionType: 'header',
                headerName: 'Authorization',
                valuePrefix: 'Key ',
              },
            ],
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
          },
        ],
      };
      writeFileSync(META_PATH, JSON.stringify(v2Data, null, 2), 'utf-8');

      const record = getCredentialMetadata('fal-ai', 'api_key');
      expect(record).toBeDefined();
      expect(record!.alias).toBe('fal-primary');
      expect(record!.injectionTemplates).toHaveLength(1);
      expect(record!.injectionTemplates![0].hostPattern).toBe('*.fal.ai');
    });

    test('future version (v3+) returns unknown version and refuses writes', () => {
      const futureData = {
        version: 99,
        credentials: [],
      };
      writeFileSync(META_PATH, JSON.stringify(futureData, null, 2), 'utf-8');

      // Reads return empty/undefined (safe degradation)
      expect(listCredentialMetadata()).toEqual([]);
      expect(getCredentialMetadata('any', 'field')).toBeUndefined();

      // Writes throw
      expect(() => upsertCredentialMetadata('test', 'key')).toThrow(/unrecognized version/);
      expect(() => assertMetadataWritable()).toThrow(/unrecognized version/);
    });

    test('upsert on migrated v1 file saves as v2', () => {
      const v1Data = {
        version: 1,
        credentials: [
          {
            credentialId: 'cred-upgrade-001',
            service: 'github',
            field: 'token',
            allowedTools: [],
            allowedDomains: [],
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
          },
        ],
      };
      writeFileSync(META_PATH, JSON.stringify(v1Data, null, 2), 'utf-8');

      // Upsert triggers load (migration) + save (at current version)
      upsertCredentialMetadata('github', 'token', { alias: 'gh-main' });

      // Verify on-disk file is now v2
      const raw = JSON.parse(require('node:fs').readFileSync(META_PATH, 'utf-8'));
      expect(raw.version).toBe(2);
      expect(raw.credentials[0].alias).toBe('gh-main');
    });
  });
});
