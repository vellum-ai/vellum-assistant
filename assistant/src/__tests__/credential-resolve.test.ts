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
  _setMetadataPath,
} from '../tools/credentials/metadata-store.js';
import {
  resolveByServiceField,
  resolveById,
} from '../tools/credentials/resolve.js';

const TEST_DIR = join(tmpdir(), `vellum-credresolve-test-${randomBytes(4).toString('hex')}`);
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

describe('credential resolver', () => {
  describe('resolveByServiceField', () => {
    test('resolves existing credential', () => {
      const created = upsertCredentialMetadata('github', 'token', {
        allowedTools: ['browser_fill_credential'],
      });

      const result = resolveByServiceField('github', 'token');
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe(created.credentialId);
      expect(result!.service).toBe('github');
      expect(result!.field).toBe('token');
      expect(result!.storageKey).toBe('credential:github:token');
      expect(result!.metadata.allowedTools).toEqual(['browser_fill_credential']);
    });

    test('returns undefined for non-existent credential', () => {
      expect(resolveByServiceField('nonexistent', 'field')).toBeUndefined();
    });
  });

  describe('resolveById', () => {
    test('resolves existing credential by ID', () => {
      const created = upsertCredentialMetadata('gmail', 'password');

      const result = resolveById(created.credentialId);
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe(created.credentialId);
      expect(result!.service).toBe('gmail');
      expect(result!.field).toBe('password');
      expect(result!.storageKey).toBe('credential:gmail:password');
    });

    test('returns undefined for non-existent ID', () => {
      expect(resolveById('non-existent-id')).toBeUndefined();
    });
  });

  describe('cross-resolution', () => {
    test('service/field and ID resolve to same credential', () => {
      const created = upsertCredentialMetadata('github', 'token');

      const byServiceField = resolveByServiceField('github', 'token');
      const byId = resolveById(created.credentialId);

      expect(byServiceField).toBeDefined();
      expect(byId).toBeDefined();
      expect(byServiceField!.credentialId).toBe(byId!.credentialId);
      expect(byServiceField!.storageKey).toBe(byId!.storageKey);
    });
  });

  describe('storage key format', () => {
    test('storage key follows credential:{service}:{field} format', () => {
      upsertCredentialMetadata('my-service', 'api-key');
      const result = resolveByServiceField('my-service', 'api-key');
      expect(result!.storageKey).toBe('credential:my-service:api-key');
    });
  });
});
