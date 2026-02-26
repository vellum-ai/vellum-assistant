import { createPrivateKey,X509Certificate } from 'node:crypto';
import { chmod,mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getLogger } from '../util/logger.js';
import { getRootDir } from '../util/platform.js';

const log = getLogger('tls-certs');

const TLS_DIR = 'tls';
const CERT_FILENAME = 'cert.pem';
const KEY_FILENAME = 'key.pem';
const FINGERPRINT_FILENAME = 'fingerprint';

/** Returns the TLS directory path (~/.vellum/tls/). */
export function getTlsDir(): string {
  return join(getRootDir(), TLS_DIR);
}

/** Returns the path to the TLS certificate. */
export function getTlsCertPath(): string {
  return join(getTlsDir(), CERT_FILENAME);
}

/** Returns the path to the TLS private key. */
export function getTlsKeyPath(): string {
  return join(getTlsDir(), KEY_FILENAME);
}

/** Returns the path to the certificate fingerprint file. */
export function getTlsFingerprintPath(): string {
  return join(getTlsDir(), FINGERPRINT_FILENAME);
}

/**
 * Compute the SHA-256 fingerprint of a DER-encoded certificate.
 * Returns hex lowercase, no colons.
 */
function computeFingerprint(cert: X509Certificate): string {
  // X509Certificate.fingerprint256 returns colon-separated uppercase hex.
  // Normalize to lowercase without colons for compact storage and comparison.
  return cert.fingerprint256.replace(/:/g, '').toLowerCase();
}

type CertStatus = 'valid' | 'approaching_expiry' | 'invalid';

/**
 * Check whether an existing cert+key pair is valid:
 * - All three files exist (cert, key, fingerprint)
 * - Cert is parseable as X509
 * - Cert is not expired
 * - Fingerprint file exists and matches the cert
 * - Private key is valid and matches the certificate
 *
 * Returns 'valid' if the cert is good, 'approaching_expiry' if it's still usable
 * but expires within 30 days (renewal should be attempted), or 'invalid' if the
 * cert cannot be used at all.
 */
async function checkCertStatus(): Promise<CertStatus> {
  const certPath = getTlsCertPath();
  const keyPath = getTlsKeyPath();
  const fpPath = getTlsFingerprintPath();

  // Check all three files exist
  const [certExists, keyExists, fpExists] = await Promise.all([
    stat(certPath).then(() => true, () => false),
    stat(keyPath).then(() => true, () => false),
    stat(fpPath).then(() => true, () => false),
  ]);

  if (!certExists || !keyExists || !fpExists) {
    return 'invalid';
  }

  try {
    const [certPem, keyPem, storedFp] = await Promise.all([
      readFile(certPath, 'utf-8'),
      readFile(keyPath, 'utf-8'),
      readFile(fpPath, 'utf-8'),
    ]);

    const x509 = new X509Certificate(certPem);

    // Check expiration
    const now = new Date();
    const notAfter = new Date(x509.validTo);
    if (notAfter <= now) {
      log.info('Existing TLS certificate has expired, will regenerate');
      return 'invalid';
    }

    // Check fingerprint matches
    const actualFp = computeFingerprint(x509);
    if (actualFp !== storedFp.trim()) {
      log.info('TLS fingerprint mismatch, will regenerate');
      return 'invalid';
    }

    // Verify the private key is valid and matches the certificate's public key.
    // This catches corrupted key files or cert/key mismatches that would cause
    // tls.createServer() to fail at runtime.
    const privateKey = createPrivateKey(keyPem);
    if (!x509.checkPrivateKey(privateKey)) {
      log.info('TLS private key does not match certificate, will regenerate');
      return 'invalid';
    }

    // Cert is structurally valid — check if it's approaching expiry
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (notAfter.getTime() - now.getTime() < thirtyDaysMs) {
      log.info('TLS certificate approaching expiry, will attempt renewal');
      return 'approaching_expiry';
    }

    return 'valid';
  } catch (err) {
    log.warn({ err }, 'Failed to validate existing TLS certificate, will regenerate');
    return 'invalid';
  }
}

/**
 * Ensure a self-signed TLS certificate exists for the daemon.
 *
 * Stores files in `~/.vellum/tls/`:
 * - `cert.pem` (0o644) — self-signed certificate
 * - `key.pem` (0o600) — private key
 * - `fingerprint` (0o644) — SHA-256 hex fingerprint (lowercase, no colons)
 *
 * Idempotent: skips generation if a valid cert already exists.
 * Auto-regenerates if the cert is expired, fingerprint is missing/mismatched,
 * or key/cert files are corrupt.
 *
 * Returns the cert, key (PEM strings), and fingerprint.
 */
export async function ensureTlsCert(): Promise<{ cert: string; key: string; fingerprint: string }> {
  const tlsDir = getTlsDir();
  const certPath = getTlsCertPath();
  const keyPath = getTlsKeyPath();
  const fpPath = getTlsFingerprintPath();

  const status = await checkCertStatus();

  if (status === 'valid') {
    const [cert, key, fingerprint] = await Promise.all([
      readFile(certPath, 'utf-8'),
      readFile(keyPath, 'utf-8'),
      readFile(fpPath, 'utf-8'),
    ]);
    log.info('Using existing TLS certificate');
    return { cert, key, fingerprint: fingerprint.trim() };
  }

  if (status === 'approaching_expiry') {
    // Attempt proactive renewal, but fall back to the existing cert if it fails.
    // The existing cert is still valid — an outage from a failed renewal would be worse
    // than continuing with a cert that expires in <30 days.
    try {
      return await generateNewCert(tlsDir, certPath, keyPath, fpPath);
    } catch (err) {
      log.warn({ err }, 'Proactive TLS renewal failed, continuing with existing certificate');
      const [cert, key, fingerprint] = await Promise.all([
        readFile(certPath, 'utf-8'),
        readFile(keyPath, 'utf-8'),
        readFile(fpPath, 'utf-8'),
      ]);
      return { cert, key, fingerprint: fingerprint.trim() };
    }
  }

  // status === 'invalid' — must regenerate, no fallback
  return await generateNewCert(tlsDir, certPath, keyPath, fpPath);
}

async function generateNewCert(
  tlsDir: string,
  certPath: string,
  keyPath: string,
  fpPath: string,
): Promise<{ cert: string; key: string; fingerprint: string }> {
  log.info('Generating new self-signed TLS certificate');
  await mkdir(tlsDir, { recursive: true });

  // Generate RSA 2048 key
  const keyProc = Bun.spawn(
    ['openssl', 'genrsa', '-out', keyPath, '2048'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const keyExit = await keyProc.exited;
  if (keyExit !== 0) {
    const stderr = await new Response(keyProc.stderr).text();
    throw new Error(`Failed to generate TLS key: ${stderr}`);
  }

  // Generate self-signed cert (1-year validity)
  const certProc = Bun.spawn(
    [
      'openssl', 'req', '-new', '-x509',
      '-key', keyPath,
      '-out', certPath,
      '-days', '365',
      '-subj', '/CN=Vellum Daemon',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const certExit = await certProc.exited;
  if (certExit !== 0) {
    const stderr = await new Response(certProc.stderr).text();
    throw new Error(`Failed to generate TLS certificate: ${stderr}`);
  }

  // Compute and write fingerprint
  const certPem = await readFile(certPath, 'utf-8');
  const x509 = new X509Certificate(certPem);
  const fingerprint = computeFingerprint(x509);
  await writeFile(fpPath, fingerprint);

  // Set permissions: key is private, cert and fingerprint are readable
  await Promise.all([
    chmod(keyPath, 0o600),
    chmod(certPath, 0o644),
    chmod(fpPath, 0o644),
  ]);

  log.info({ fingerprint, certPath }, 'TLS certificate generated');
  return {
    cert: certPem,
    key: await readFile(keyPath, 'utf-8'),
    fingerprint,
  };
}
