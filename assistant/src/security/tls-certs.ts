import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getRootDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';

const execAsync = promisify(exec);
const log = getLogger('tls-certs');

/**
 * Check if OpenSSL is available in PATH
 */
async function checkOpenSSLAvailable(): Promise<boolean> {
  try {
    await execAsync('openssl version');
    return true;
  } catch {
    return false;
  }
}

export interface TLSCertPaths {
  certPath: string;
  keyPath: string;
}

/**
 * Get the default paths for TLS certificates
 */
export function getDefaultCertPaths(): TLSCertPaths {
  const certsDir = join(getRootDir(), 'certs');
  return {
    certPath: join(certsDir, 'daemon.crt'),
    keyPath: join(certsDir, 'daemon.key'),
  };
}

/**
 * Check if TLS certificates exist at the given paths
 */
export function certificatesExist(certPath: string, keyPath: string): boolean {
  return existsSync(certPath) && existsSync(keyPath);
}

/**
 * Generate self-signed TLS certificates for the daemon.
 * Uses OpenSSL to create a 2048-bit RSA key and certificate valid for 365 days.
 *
 * The certificate is generated with:
 * - Subject: CN=vellum-daemon
 * - Valid for 365 days
 * - SHA256 signature
 * - No password on private key
 */
export async function generateSelfSignedCert(certPath: string, keyPath: string): Promise<void> {
  // Check if OpenSSL is available
  const hasOpenSSL = await checkOpenSSLAvailable();
  if (!hasOpenSSL) {
    throw new Error('OpenSSL is not installed or not available in PATH. Please install OpenSSL to use TCP/TLS mode.');
  }

  // Ensure parent directories exist for both cert and key paths
  const certDir = dirname(certPath);
  const keyDir = dirname(keyPath);

  if (!existsSync(certDir)) {
    mkdirSync(certDir, { recursive: true, mode: 0o700 });
  }
  if (certDir !== keyDir && !existsSync(keyDir)) {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  }

  log.info({ certPath, keyPath }, 'Generating self-signed TLS certificate');

  try {
    // Validate paths to prevent shell injection
    if (certPath.includes("'") || certPath.includes('"') || keyPath.includes("'") || keyPath.includes('"')) {
      throw new Error('Certificate paths cannot contain quotes');
    }

    // Generate private key and certificate in one command
    // Use single quotes to prevent shell expansion
    const cmd = [
      'openssl req',
      '-x509',
      '-newkey rsa:2048',
      '-nodes',
      `-keyout '${keyPath}'`,
      `-out '${certPath}'`,
      '-days 365',
      '-subj "/CN=vellum-daemon"',
      '-sha256',
    ].join(' ');

    await execAsync(cmd);

    // Set restrictive permissions using Node's chmodSync (cross-platform)
    try {
      chmodSync(keyPath, 0o600);
      chmodSync(certPath, 0o644);
    } catch (chmodErr) {
      // Log but don't fail - permissions are best-effort on some platforms
      log.warn({ err: chmodErr, keyPath, certPath }, 'Failed to set file permissions (may be unsupported on this platform)');
    }

    log.info({ certPath, keyPath }, 'Successfully generated self-signed TLS certificate');
  } catch (err) {
    log.error({ err, certPath, keyPath }, 'Failed to generate TLS certificate');
    throw new Error(`Failed to generate TLS certificate: ${(err as Error).message}`);
  }
}

/**
 * Ensure TLS certificates exist. If they don't exist at the specified paths,
 * generate new self-signed certificates.
 */
export async function ensureCertificates(certPath: string, keyPath: string): Promise<void> {
  if (!certificatesExist(certPath, keyPath)) {
    log.info('TLS certificates not found, generating new self-signed certificate');
    await generateSelfSignedCert(certPath, keyPath);
  } else {
    log.info({ certPath, keyPath }, 'TLS certificates found');
  }
}

/**
 * Read TLS certificate and key files
 */
export function readCertificates(certPath: string, keyPath: string): { cert: Buffer; key: Buffer } {
  try {
    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };
  } catch (err) {
    log.error({ err, certPath, keyPath }, 'Failed to read TLS certificates');
    throw new Error(`Failed to read TLS certificates: ${(err as Error).message}`);
  }
}
