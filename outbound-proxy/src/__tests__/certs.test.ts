import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  ensureCombinedCABundle,
  ensureLocalCA,
  getCAPath,
  getCombinedCAPath,
  issueLeafCert,
} from '../certs.js';

let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'proxy-sidecar-certs-test-'));
  await ensureLocalCA(dataDir);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('ensureLocalCA', () => {
  test('creates CA cert and key with correct permissions', async () => {
    await ensureLocalCA(dataDir);

    const caDir = join(dataDir, 'proxy-ca');
    const certStat = await stat(join(caDir, 'ca.pem'));
    const keyStat = await stat(join(caDir, 'ca-key.pem'));

    expect(certStat.isFile()).toBe(true);
    expect(keyStat.isFile()).toBe(true);

    // Check permissions (mask with 0o777 to get just the permission bits)
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(certStat.mode & 0o777).toBe(0o644);
  });

  test('is idempotent -- repeated calls do not regenerate', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    const certBefore = await readFile(join(caDir, 'ca.pem'), 'utf-8');
    const keyBefore = await readFile(join(caDir, 'ca-key.pem'), 'utf-8');

    await ensureLocalCA(dataDir);

    const certAfter = await readFile(join(caDir, 'ca.pem'), 'utf-8');
    const keyAfter = await readFile(join(caDir, 'ca-key.pem'), 'utf-8');

    expect(certAfter).toBe(certBefore);
    expect(keyAfter).toBe(keyBefore);
  });

  test('CA cert is a valid PEM certificate', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    const cert = await readFile(join(caDir, 'ca.pem'), 'utf-8');
    expect(cert).toContain('BEGIN CERTIFICATE');
    expect(cert).toContain('END CERTIFICATE');
  });

  test('CA key is a valid PEM private key', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    const key = await readFile(join(caDir, 'ca-key.pem'), 'utf-8');
    expect(key).toContain('BEGIN');
    expect(key).toContain('END');
  });
});

describe('issueLeafCert', () => {
  const HOSTNAME = 'example.com';

  test('generates a leaf cert for a hostname', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    const result = await issueLeafCert(caDir, HOSTNAME);

    expect(result.cert).toContain('BEGIN CERTIFICATE');
    expect(result.key).toContain('BEGIN');

    // Verify the issued files exist on disk
    const issuedDir = join(caDir, 'issued');
    const certStat_ = await stat(join(issuedDir, `${HOSTNAME}.pem`));
    const keyStat_ = await stat(join(issuedDir, `${HOSTNAME}-key.pem`));
    expect(certStat_.isFile()).toBe(true);
    expect(keyStat_.isFile()).toBe(true);
  });

  test('returns cached cert on repeated calls', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    const first = await issueLeafCert(caDir, HOSTNAME);
    const second = await issueLeafCert(caDir, HOSTNAME);

    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  test('generates different certs for different hostnames', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    const certA = await issueLeafCert(caDir, 'a.example.com');
    const certB = await issueLeafCert(caDir, 'b.example.com');

    expect(certA.cert).not.toBe(certB.cert);
    expect(certA.key).not.toBe(certB.key);
  });

  test('rejects invalid hostname characters', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    await expect(issueLeafCert(caDir, 'host name with spaces')).rejects.toThrow(
      'Invalid hostname',
    );
  });

  test('rejects hostname with path traversal characters', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    await expect(issueLeafCert(caDir, '../etc/passwd')).rejects.toThrow(
      'Invalid hostname',
    );
  });

  test('rejects hostname with special characters', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    await expect(issueLeafCert(caDir, 'host;rm -rf /')).rejects.toThrow(
      'Invalid hostname',
    );
  });

  test('allows wildcard hostnames', async () => {
    const caDir = join(dataDir, 'proxy-ca');
    const result = await issueLeafCert(caDir, '*.example.com');
    expect(result.cert).toContain('BEGIN CERTIFICATE');
    expect(result.key).toContain('BEGIN');
  });
});

describe('getCAPath', () => {
  test('returns the correct path to the CA cert', () => {
    const result = getCAPath('/some/data/dir');
    expect(result).toBe('/some/data/dir/proxy-ca/ca.pem');
  });
});

describe('getCombinedCAPath', () => {
  test('returns the correct path to the combined CA bundle', () => {
    const result = getCombinedCAPath('/some/data/dir');
    expect(result).toBe('/some/data/dir/proxy-ca/combined-ca-bundle.pem');
  });
});

describe('ensureCombinedCABundle', () => {
  test('creates combined bundle when system CA exists', async () => {
    // This test may return null if no system CA bundle is found on the machine
    const result = await ensureCombinedCABundle(dataDir);
    if (result !== null) {
      const bundleContent = await readFile(result, 'utf-8');
      // Should contain the proxy CA cert
      const proxyCert = await readFile(
        join(dataDir, 'proxy-ca', 'ca.pem'),
        'utf-8',
      );
      expect(bundleContent).toContain(proxyCert.trim());
    }
    // If result is null, system has no CA bundle at known paths -- that's ok
  });

  test('is idempotent when combined bundle is fresh', async () => {
    const first = await ensureCombinedCABundle(dataDir);
    const second = await ensureCombinedCABundle(dataDir);
    // Both should return the same result
    expect(second).toBe(first);
  });
});
