/**
 * Bundle signing for .vellumapp archives.
 *
 * Computes content hashes, constructs a canonical signing payload,
 * and requests an Ed25519 signature from the Swift client via IPC.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

export interface SignatureJson {
  algorithm: 'ed25519';
  signer: {
    key_id: string;
    display_name: string;
    account?: string;
  };
  content_hashes: Record<string, string>;
  signature: string; // base64-encoded
}

/**
 * Callback type for requesting a signature from the Swift client via IPC.
 * The caller provides this so the signer doesn't need to know about IPC details.
 */
export type SigningCallback = (payload: string) => Promise<{
  signature: string; // base64-encoded
  keyId: string;
  publicKey: string;
}>;

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
 * Compute SHA-256 hashes of all files in a zip archive, excluding signature.json.
 */
async function computeContentHashes(zip: JSZip): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const entries: string[] = [];

  zip.forEach((relativePath, _file) => {
    if (relativePath !== 'signature.json') {
      entries.push(relativePath);
    }
  });

  // Sort for deterministic ordering
  entries.sort();

  for (const entryPath of entries) {
    const file = zip.file(entryPath);
    if (!file || file.dir) continue;
    const content = await file.async('nodebuffer');
    const hash = createHash('sha256').update(content).digest('hex');
    hashes[entryPath] = hash;
  }

  return hashes;
}

/**
 * Sign a .vellumapp bundle.
 *
 * @param bundlePath - Path to the .vellumapp zip archive.
 * @param requestSignature - Callback to request a signature from the Swift client.
 * @returns The SignatureJson to embed in the archive.
 */
export async function signBundle(
  bundlePath: string,
  requestSignature: SigningCallback,
): Promise<SignatureJson> {
  const zipBuffer = await readFile(bundlePath);
  const zip = await JSZip.loadAsync(zipBuffer);

  // 1. Compute content hashes
  const contentHashes = await computeContentHashes(zip);

  // 2. Read manifest
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Bundle is missing manifest.json');
  }
  const manifestText = await manifestFile.async('text');
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;

  // 3. Construct canonical signing payload with sorted keys
  const signingPayload = sortKeysDeep({
    content_hashes: contentHashes,
    manifest,
  });
  const canonicalPayload = JSON.stringify(signingPayload);

  // 4. Request signature from Swift via IPC
  const { signature, keyId } = await requestSignature(canonicalPayload);

  // 5. Build SignatureJson
  const signatureJson: SignatureJson = {
    algorithm: 'ed25519',
    signer: {
      key_id: keyId,
      display_name: 'Local Signer',
    },
    content_hashes: contentHashes,
    signature,
  };

  return signatureJson;
}
