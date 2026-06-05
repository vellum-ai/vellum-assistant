import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import { resolveRelativePath } from "./app-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BundleMetadata {
  uuid: string;
  name: string;
  description?: string;
  icon?: string;
  entry: string;
  trustTier: "verified" | "signed" | "unsigned" | "tampered";
  signerKeyId?: string;
  signerDisplayName?: string;
  signerAccount?: string;
  installedAt: string;
  bundleSizeBytes: number;
  capabilities: string[];
}

export interface BundleScanData {
  manifest: {
    format_version: number;
    name: string;
    description?: string;
    icon?: string;
    entry: string;
    capabilities: string[];
    created_by: string;
    created_at: string;
  };
  scanResult: {
    passed: boolean;
    blocked: string[];
    warnings: string[];
  };
  signatureResult: {
    trustTier: "verified" | "signed" | "unsigned" | "tampered";
    signerKeyId?: string;
    signerDisplayName?: string;
    signerAccount?: string;
    message?: string;
  };
  bundleSizeBytes: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve an entry name inside a bundle directory, throwing on escape. */
function resolveEntryPath(bundleDir: string, entryName: string): string {
  const result = resolveRelativePath(bundleDir, entryName);
  if (result.kind === "forbidden") {
    throw new Error(`Path traversal detected: ${entryName}`);
  }
  return result.resolved;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function unpackBundle(
  bundlesRoot: string,
  zipPath: string,
  scanData: BundleScanData,
): Promise<BundleMetadata> {
  const uuid = crypto.randomUUID();
  const bundleDir = path.join(bundlesRoot, uuid);
  await fs.mkdir(bundleDir, { recursive: true });

  const zipData = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(zipData);

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;

    const resolved = resolveEntryPath(bundleDir, entryName);

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const data = await entry.async("nodebuffer");
    await fs.writeFile(resolved, data);
  }

  await stripUnsafeEntries(bundleDir);

  const metadata: BundleMetadata = {
    uuid,
    name: scanData.manifest.name,
    description: scanData.manifest.description,
    icon: scanData.manifest.icon,
    entry: scanData.manifest.entry,
    trustTier: scanData.signatureResult.trustTier,
    signerKeyId: scanData.signatureResult.signerKeyId,
    signerDisplayName: scanData.signatureResult.signerDisplayName,
    signerAccount: scanData.signatureResult.signerAccount,
    installedAt: new Date().toISOString(),
    bundleSizeBytes: scanData.bundleSizeBytes,
    capabilities: scanData.manifest.capabilities,
  };

  await fs.writeFile(
    path.join(bundlesRoot, uuid + "-meta.json"),
    JSON.stringify(metadata, null, 2),
  );

  return metadata;
}

export async function stripUnsafeEntries(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      await fs.rm(fullPath);
      continue;
    }

    if (entry.isDirectory()) {
      await stripUnsafeEntries(fullPath);
      continue;
    }

    // lstat only for regular files to detect hardlinks (nlink > 1)
    const stat = await fs.lstat(fullPath);
    if (stat.nlink > 1) {
      await fs.rm(fullPath);
    }
  }
}

export async function readBundleMetadata(
  bundlesRoot: string,
  uuid: string,
): Promise<BundleMetadata | null> {
  try {
    const raw = await fs.readFile(
      path.join(bundlesRoot, uuid + "-meta.json"),
      "utf-8",
    );
    return JSON.parse(raw) as BundleMetadata;
  } catch {
    return null;
  }
}

export async function listBundles(
  bundlesRoot: string,
): Promise<BundleMetadata[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(bundlesRoot);
  } catch {
    return [];
  }

  const metaFiles = entries.filter((e) => e.endsWith("-meta.json"));
  const results: BundleMetadata[] = [];

  for (const file of metaFiles) {
    try {
      const raw = await fs.readFile(path.join(bundlesRoot, file), "utf-8");
      results.push(JSON.parse(raw) as BundleMetadata);
    } catch {
      // Skip malformed metadata files
    }
  }

  return results;
}

export async function removeBundle(
  bundlesRoot: string,
  uuid: string,
): Promise<void> {
  await fs.rm(path.join(bundlesRoot, uuid), { recursive: true, force: true });
  await fs.rm(path.join(bundlesRoot, uuid + "-meta.json"), { force: true });
}
