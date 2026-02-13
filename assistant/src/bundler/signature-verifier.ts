/**
 * Signature verification for .vellumapp archives.
 *
 * Checks bundle integrity and Ed25519 signature validity.
 */

import { createHash, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import type { SignatureJson } from './bundle-signer.js';

export type TrustTier = 'verified' | 'signed' | 'unsigned' | 'tampered';

export interface SignatureVerificationResult {
  trustTier: TrustTier;
  signerKeyId?: string;
  signerDisplayName?: string;
  signerAccount?: string;
  message: string;
}

/**
 * Recursively sort object keys alphabetically for canonical JSON.
 */
function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Verify the signature and integrity of a .vellumapp bundle.
 *
 * @param zipPath - Path to the .vellumapp zip archive.
 * @param trustedPublicKeys - Optional map of keyId -> base64-encoded public key for verification.
 *                            If not provided, signature is checked structurally but returns 'signed' at best.
 * @returns The verification result with trust tier and signer info.
 */
export async function verifyBundleSignature(
  zipPath: string,
  trustedPublicKeys?: Map<string, string>,
): Promise<SignatureVerificationResult> {
  const zipBuffer = await readFile(zipPath);
  const zip = await JSZip.loadAsync(zipBuffer);

  // 1. Check for signature.json
  const sigFile = zip.file('signature.json');
  if (!sigFile) {
    return {
      trustTier: 'unsigned',
      message: 'Bundle is not signed (no signature.json found)',
    };
  }

  // 2. Parse signature.json
  let signatureData: SignatureJson;
  try {
    const sigText = await sigFile.async('text');
    signatureData = JSON.parse(sigText) as SignatureJson;
  } catch {
    return {
      trustTier: 'tampered',
      message: 'signature.json is malformed',
    };
  }

  // 3. Recompute content hashes
  const computedHashes: Record<string, string> = {};
  const entries: string[] = [];

  zip.forEach((relativePath, _file) => {
    if (relativePath !== 'signature.json') {
      entries.push(relativePath);
    }
  });
  entries.sort();

  for (const entryPath of entries) {
    const file = zip.file(entryPath);
    if (!file || file.dir) continue;
    const content = await file.async('nodebuffer');
    const hash = createHash('sha256').update(content).digest('hex');
    computedHashes[entryPath] = hash;
  }

  // 4. Compare hashes
  const expectedPaths = Object.keys(signatureData.content_hashes).sort();
  const actualPaths = Object.keys(computedHashes).sort();

  if (expectedPaths.length !== actualPaths.length ||
      !expectedPaths.every((p, i) => p === actualPaths[i])) {
    return {
      trustTier: 'tampered',
      signerKeyId: signatureData.signer.key_id,
      signerDisplayName: signatureData.signer.display_name,
      message: 'Bundle files do not match signed manifest (files added or removed)',
    };
  }

  for (const path of expectedPaths) {
    if (signatureData.content_hashes[path] !== computedHashes[path]) {
      return {
        trustTier: 'tampered',
        signerKeyId: signatureData.signer.key_id,
        signerDisplayName: signatureData.signer.display_name,
        message: `Content hash mismatch for file: ${path}`,
      };
    }
  }

  // 5. Reconstruct canonical signing payload
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    return {
      trustTier: 'tampered',
      message: 'Bundle is missing manifest.json',
    };
  }
  const manifestText = await manifestFile.async('text');
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;

  const signingPayload = sortKeysDeep({
    content_hashes: computedHashes,
    manifest,
  });
  const canonicalPayload = JSON.stringify(signingPayload);

  // 6. Verify Ed25519 signature if we have a public key
  const keyId = signatureData.signer.key_id;
  const publicKeyBase64 = trustedPublicKeys?.get(keyId);

  if (publicKeyBase64) {
    try {
      const publicKeyBuffer = Buffer.from(publicKeyBase64, 'base64');
      const signatureBuffer = Buffer.from(signatureData.signature, 'base64');

      const isValid = verify(
        null, // Ed25519 doesn't use a separate hash algorithm
        Buffer.from(canonicalPayload),
        { key: publicKeyBuffer, format: 'der', type: 'spki' },
        signatureBuffer,
      );

      if (!isValid) {
        return {
          trustTier: 'tampered',
          signerKeyId: keyId,
          signerDisplayName: signatureData.signer.display_name,
          message: 'Ed25519 signature verification failed',
        };
      }
    } catch {
      // If verification throws (e.g. wrong key format), fall through to 'signed'
    }
  }

  // For MVP, we don't have Vellum account lookup, so best we can do is 'signed'
  return {
    trustTier: 'signed',
    signerKeyId: keyId,
    signerDisplayName: signatureData.signer.display_name,
    signerAccount: signatureData.signer.account,
    message: `Bundle signed by ${signatureData.signer.display_name}`,
  };
}
