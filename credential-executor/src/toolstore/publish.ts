/**
 * Immutable toolstore publisher.
 *
 * Downloads (or re-fetches) secure command bundles inside CES, verifies
 * their digest against the declared expected value, and writes them into
 * content-addressed directories within the CES-private data root.
 *
 * ## Invariants
 *
 * 1. **CES-only writes** — All bundle content is written to the CES
 *    toolstore directory, which lives under the CES-private data root.
 *    The assistant process cannot read or write this path.
 *
 * 2. **Immutable publications** — Once a digest directory exists, it is
 *    never overwritten. Re-publishing the same digest is a deduplicated
 *    no-op that returns success.
 *
 * 3. **Digest verification before write** — Downloaded bytes are verified
 *    against the expected digest before any file is created. A mismatch
 *    is a hard error; no partial writes occur.
 *
 * 4. **No credential grants** — Publishing a bundle into the toolstore
 *    is a pure content operation. It does not create, modify, or imply
 *    any credential-use grant.
 *
 * 5. **No workspace-origin bundles** — Source URLs that point to the
 *    workspace directory or use non-HTTPS schemes are rejected.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getCesToolStoreDir, type CesMode } from "../paths.js";
import type { SecureCommandManifest } from "../commands/profiles.js";
import { validateManifest } from "../commands/validator.js";
import { verifyDigest } from "./integrity.js";
import {
  isValidSha256Hex,
  isWorkspaceOriginPath,
  validateSourceUrl,
  type ToolstoreManifest,
} from "./manifest.js";

// ---------------------------------------------------------------------------
// Publication result
// ---------------------------------------------------------------------------

export interface PublishResult {
  /** Whether the publication succeeded. */
  success: boolean;

  /**
   * Whether this was a deduplicated no-op (the digest directory already
   * existed from a previous publication).
   */
  deduplicated: boolean;

  /** The content-addressed directory path where the bundle is stored. */
  bundlePath: string;

  /** Error message if publication failed (undefined on success). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Publish request
// ---------------------------------------------------------------------------

export interface PublishRequest {
  /** Raw bundle bytes to publish. */
  bundleBytes: Buffer | Uint8Array;

  /** Expected SHA-256 hex digest of the bundle bytes. */
  expectedDigest: string;

  /** Unique identifier for the command bundle. */
  bundleId: string;

  /** Semantic version of the bundle. */
  version: string;

  /** HTTPS URL from which the bundle was fetched. */
  sourceUrl: string;

  /** The secure command manifest for this bundle. */
  secureCommandManifest: SecureCommandManifest;

  /** CES mode override (defaults to auto-detection). */
  cesMode?: CesMode;
}

// ---------------------------------------------------------------------------
// Content-addressed path helpers
// ---------------------------------------------------------------------------

/** Manifest filename within a content-addressed bundle directory. */
const MANIFEST_FILENAME = "toolstore-manifest.json";

/** Bundle content filename within a content-addressed bundle directory. */
const BUNDLE_FILENAME = "bundle.bin";

/**
 * Return the content-addressed directory path for a given digest.
 *
 * Layout: `<toolstoreDir>/<digest>/`
 *
 * @throws {Error} if digest is not a valid SHA-256 hex string.
 */
export function getBundleDir(
  toolstoreDir: string,
  digest: string,
): string {
  if (!isValidSha256Hex(digest)) {
    throw new Error(`Invalid digest "${digest}": must be a 64-character lowercase hex SHA-256 digest.`);
  }
  return join(toolstoreDir, digest);
}

/**
 * Return the manifest file path for a given digest.
 *
 * @throws {Error} if digest is not a valid SHA-256 hex string.
 */
export function getBundleManifestPath(
  toolstoreDir: string,
  digest: string,
): string {
  return join(getBundleDir(toolstoreDir, digest), MANIFEST_FILENAME);
}

/**
 * Return the bundle content file path for a given digest.
 *
 * @throws {Error} if digest is not a valid SHA-256 hex string.
 */
export function getBundleContentPath(
  toolstoreDir: string,
  digest: string,
): string {
  return join(getBundleDir(toolstoreDir, digest), BUNDLE_FILENAME);
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

/**
 * Publish a secure command bundle into the CES-private immutable
 * toolstore.
 *
 * This function:
 * 1. Validates the source URL (HTTPS only, no workspace origins).
 * 2. Validates the expected digest format.
 * 3. Validates the secure command manifest.
 * 4. Verifies the bundle bytes match the expected digest.
 * 5. Checks for deduplication (returns early if already published).
 * 6. Writes bundle contents and manifest atomically.
 *
 * Returns a {@link PublishResult} describing the outcome.
 */
export function publishBundle(request: PublishRequest): PublishResult {
  const {
    bundleBytes,
    expectedDigest,
    bundleId,
    version,
    sourceUrl,
    secureCommandManifest,
    cesMode,
  } = request;

  const toolstoreDir = getCesToolStoreDir(cesMode);

  // -- Validate source URL ------------------------------------------------
  const urlError = validateSourceUrl(sourceUrl);
  if (urlError) {
    return {
      success: false,
      deduplicated: false,
      bundlePath: "",
      error: `Invalid source URL: ${urlError}`,
    };
  }

  // -- Reject workspace-origin paths in the URL ---------------------------
  try {
    const parsedUrl = new URL(sourceUrl);
    const rawPathname = parsedUrl.pathname;

    // Always check the raw pathname — this must not be skipped.
    if (isWorkspaceOriginPath(rawPathname)) {
      return {
        success: false,
        deduplicated: false,
        bundlePath: "",
        error: `Source URL path "${rawPathname}" appears to be a workspace-origin path. ` +
          `Workspace-origin binaries are never publishable.`,
      };
    }

    // Also check the decoded pathname for percent-encoded traversals.
    try {
      const decodedPathname = decodeURIComponent(rawPathname);
      if (decodedPathname !== rawPathname && isWorkspaceOriginPath(decodedPathname)) {
        return {
          success: false,
          deduplicated: false,
          bundlePath: "",
          error: `Source URL path "${decodedPathname}" (decoded from "${rawPathname}") appears to be a workspace-origin path. ` +
            `Workspace-origin binaries are never publishable.`,
        };
      }
    } catch {
      // decodeURIComponent threw URIError on malformed sequences (e.g. %C0%AF).
      // The raw pathname was already checked above, so we're safe.
    }
  } catch {
    // URL parsing already validated above
  }

  // -- Validate digest format ---------------------------------------------
  if (!isValidSha256Hex(expectedDigest)) {
    return {
      success: false,
      deduplicated: false,
      bundlePath: "",
      error: `Invalid expectedDigest "${expectedDigest}". ` +
        `Must be a 64-character lowercase hex SHA-256 digest.`,
    };
  }

  // -- Validate secure command manifest -----------------------------------
  const manifestValidation = validateManifest(secureCommandManifest);
  if (!manifestValidation.valid) {
    return {
      success: false,
      deduplicated: false,
      bundlePath: "",
      error: `Invalid secure command manifest: ${manifestValidation.errors.join("; ")}`,
    };
  }

  // -- Validate manifest metadata matches request -------------------------
  const metadataMismatches: string[] = [];
  if (secureCommandManifest.bundleDigest !== expectedDigest) {
    metadataMismatches.push(
      `bundleDigest "${secureCommandManifest.bundleDigest}" does not match expectedDigest "${expectedDigest}"`,
    );
  }
  if (secureCommandManifest.bundleId !== bundleId) {
    metadataMismatches.push(
      `bundleId "${secureCommandManifest.bundleId}" does not match request bundleId "${bundleId}"`,
    );
  }
  if (secureCommandManifest.version !== version) {
    metadataMismatches.push(
      `version "${secureCommandManifest.version}" does not match request version "${version}"`,
    );
  }
  if (metadataMismatches.length > 0) {
    return {
      success: false,
      deduplicated: false,
      bundlePath: "",
      error: `Manifest metadata mismatch: ${metadataMismatches.join("; ")}`,
    };
  }

  // -- Verify bundle digest -----------------------------------------------
  const digestResult = verifyDigest(bundleBytes, expectedDigest);
  if (!digestResult.valid) {
    return {
      success: false,
      deduplicated: false,
      bundlePath: "",
      error: digestResult.error!,
    };
  }

  // -- Deduplication check ------------------------------------------------
  const bundleDir = getBundleDir(toolstoreDir, expectedDigest);
  const manifestPath = getBundleManifestPath(toolstoreDir, expectedDigest);

  if (existsSync(bundleDir) && existsSync(manifestPath)) {
    // Already published — deduplicated no-op
    return {
      success: true,
      deduplicated: true,
      bundlePath: bundleDir,
    };
  }

  // -- Ensure toolstore directory exists -----------------------------------
  mkdirSync(toolstoreDir, { recursive: true });

  // -- Write bundle atomically --------------------------------------------
  //
  // Write to a staging directory first, then rename to the final
  // content-addressed path. This prevents partial writes from being
  // visible to readers.
  const stagingDir = join(toolstoreDir, `.staging-${expectedDigest}-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    // Write bundle content to a unique staging filename so that if the
    // archive itself contains a root-level "bundle.bin", extraction won't
    // collide with the staging archive file.
    const stagingArchiveName = `.ces-bundle-staging-${Date.now()}.tar.gz`;
    const stagingBundlePath = join(stagingDir, stagingArchiveName);
    writeFileSync(stagingBundlePath, bundleBytes, { mode: 0o444 });

    // Extract the tar.gz archive into the staging directory.
    // The archive is expected to contain the runnable bundle contents,
    // including the entrypoint declared in the manifest.
    const extractProc = Bun.spawnSync(
      ["tar", "xzf", stagingBundlePath, "-C", stagingDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (extractProc.exitCode !== 0) {
      const stderr = extractProc.stderr
        ? new TextDecoder().decode(extractProc.stderr).trim()
        : "unknown error";
      throw new Error(
        `Bundle extraction failed (exit code ${extractProc.exitCode}): ${stderr}`,
      );
    }

    // Remove the raw archive — the extracted contents replace it
    try {
      unlinkSync(stagingBundlePath);
    } catch {
      // Best effort — the file may have been overwritten by extraction
    }

    // Scan for symlinks that escape the bundle directory.
    // A symlink pointing outside the staging directory could allow the
    // entrypoint to execute arbitrary binaries on the host.
    const escapingSymlinks = findEscapingSymlinks(stagingDir);
    if (escapingSymlinks.length > 0) {
      throw new Error(
        `Bundle contains symlinks that point outside the bundle directory: ${escapingSymlinks.join(", ")}. ` +
        `Symlink escape is not allowed.`,
      );
    }

    // Validate that the declared entrypoint resolves inside the staging
    // directory. A manifest with an absolute or `../`-traversal entrypoint
    // could make chmod (or later execution) touch files outside the bundle.
    const extractedEntrypoint = resolve(stagingDir, secureCommandManifest.entrypoint);
    const realStagingDir = realpathSync(stagingDir);
    if (extractedEntrypoint !== realStagingDir && !extractedEntrypoint.startsWith(realStagingDir + "/")) {
      throw new Error(
        `Entrypoint "${secureCommandManifest.entrypoint}" resolves outside the bundle directory. ` +
        `Path traversal in entrypoint values is not allowed.`,
      );
    }

    // Check that the entrypoint itself is not a symlink (use lstat to avoid following)
    try {
      const entrypointStat = lstatSync(extractedEntrypoint);
      if (entrypointStat.isSymbolicLink()) {
        throw new Error(
          `Entrypoint "${secureCommandManifest.entrypoint}" is a symbolic link. ` +
          `Symlink entrypoints are not allowed — the entrypoint must be a regular file.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Symlink entrypoints")) {
        throw err;
      }
      // lstat failed — the file doesn't exist, fall through to existsSync check
    }

    if (!existsSync(extractedEntrypoint)) {
      throw new Error(
        `Entrypoint "${secureCommandManifest.entrypoint}" not found in extracted bundle contents. ` +
        `The archive must contain the declared entrypoint path.`,
      );
    }

    // Make the entrypoint executable
    chmodSync(extractedEntrypoint, 0o555);

    // Build and write toolstore manifest
    const toolstoreManifest: ToolstoreManifest = {
      digest: expectedDigest,
      bundleId,
      version,
      origin: {
        sourceUrl,
        fetchedAt: new Date().toISOString(),
      },
      declaredProfiles: Object.keys(secureCommandManifest.commandProfiles),
      secureCommandManifest,
      publishedAt: new Date().toISOString(),
    };

    const stagingManifestPath = join(stagingDir, MANIFEST_FILENAME);
    writeFileSync(
      stagingManifestPath,
      JSON.stringify(toolstoreManifest, null, 2) + "\n",
      { mode: 0o444 },
    );

    // Rename staging directory to final content-addressed path
    //
    // On POSIX, rename() is atomic within a filesystem. Since the
    // staging dir is in the same parent as the final dir, this is
    // a same-filesystem rename.
    renameSync(stagingDir, bundleDir);
  } catch (err) {
    // Clean up staging directory on failure
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
    // Re-check: another process may have published the same digest concurrently
    if (existsSync(bundleDir) && existsSync(manifestPath)) {
      return {
        success: true,
        deduplicated: true,
        bundlePath: bundleDir,
      };
    }
    return {
      success: false,
      deduplicated: false,
      bundlePath: "",
      error: `Failed to write bundle to toolstore: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    success: true,
    deduplicated: false,
    bundlePath: bundleDir,
  };
}

// ---------------------------------------------------------------------------
// Reader helpers
// ---------------------------------------------------------------------------

/**
 * Read a published toolstore manifest by digest.
 *
 * Returns null if no bundle with the given digest is published or if the
 * digest is not a valid SHA-256 hex string.
 */
export function readPublishedManifest(
  digest: string,
  cesMode?: CesMode,
): ToolstoreManifest | null {
  if (!isValidSha256Hex(digest)) {
    return null;
  }

  const toolstoreDir = getCesToolStoreDir(cesMode);
  const manifestPath = getBundleManifestPath(toolstoreDir, digest);

  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as ToolstoreManifest;
  } catch {
    return null;
  }
}

/**
 * Check if a bundle with the given digest is published in the toolstore.
 *
 * Returns false if the digest is not a valid SHA-256 hex string.
 */
export function isBundlePublished(
  digest: string,
  cesMode?: CesMode,
): boolean {
  if (!isValidSha256Hex(digest)) {
    return false;
  }

  const toolstoreDir = getCesToolStoreDir(cesMode);
  const bundleDir = getBundleDir(toolstoreDir, digest);
  const manifestPath = getBundleManifestPath(toolstoreDir, digest);
  return existsSync(bundleDir) && existsSync(manifestPath);
}

// ---------------------------------------------------------------------------
// Symlink escape detection
// ---------------------------------------------------------------------------

/**
 * Recursively scan a directory for symlinks that point outside of it.
 *
 * Returns an array of relative paths (from `rootDir`) of symlinks whose
 * resolved target falls outside `rootDir`.
 */
function findEscapingSymlinks(rootDir: string): string[] {
  const escaping: string[] = [];
  const realRoot = realpathSync(rootDir);

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        // Resolve the symlink target relative to its parent directory
        const linkTarget = readlinkSync(fullPath);
        const resolvedTarget = resolve(dir, linkTarget);
        // Check if the resolved target is outside the root directory
        if (!resolvedTarget.startsWith(realRoot + "/") && resolvedTarget !== realRoot) {
          const relativePath = fullPath.slice(realRoot.length + 1);
          escaping.push(relativePath);
        }
      } else if (stat.isDirectory()) {
        walk(fullPath);
      }
    }
  }

  walk(realRoot);
  return escaping;
}
