import { type Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { APP_VERSION } from "../../version.js";
import {
  assertBundleFits,
  getImportByteBudget,
  MAX_BUNDLE_ENTRIES,
} from "./bundle-capacity.js";
import {
  analyzeImportAsync,
  type PathResolver,
} from "./vbundle-import-analyzer.js";
import {
  evaluateRuntimeCompatibility,
  formatRuntimeCompatibilityMessage,
} from "./vbundle-import-policy.js";
import {
  createHashVerifier,
  readAndValidateManifest,
  StreamingValidationError,
  verifySymlinkEntry,
} from "./vbundle-streaming-validator.js";
import { parseVBundleStream } from "./vbundle-tar-stream.js";

export async function preflightBundleStream(
  source: Readable,
  pathResolver: PathResolver,
  workspaceDir: string,
  maxBundleBytes?: number,
) {
  const entries = parseVBundleStream(source);
  try {
    const budget = Math.min(
      maxBundleBytes ?? Number.MAX_SAFE_INTEGER,
      getImportByteBudget(workspaceDir),
    );
    const first = await entries.next();
    if (first.done) {
      throw new StreamingValidationError(
        "empty_archive",
        "Bundle archive is empty",
      );
    }
    const { manifest, expected } = await readAndValidateManifest(first.value);
    const compatibility = evaluateRuntimeCompatibility(
      manifest.compatibility,
      APP_VERSION,
    );
    if (!compatibility.ok) {
      throw new StreamingValidationError(
        "version_incompatible",
        formatRuntimeCompatibilityMessage(
          compatibility.bundle_compat,
          compatibility.runtime_version,
        ),
      );
    }
    assertBundleFits(
      manifest.contents.reduce((n, file) => n + file.size_bytes, 0),
      budget,
    );
    if (manifest.contents.length > MAX_BUNDLE_ENTRIES) {
      throw new StreamingValidationError(
        "bundle_too_many_entries",
        "Bundle contains more than 100000 entries",
      );
    }
    const seen = new Set<string>();
    let entryCount = 0;
    let totalBytes = 0;
    for await (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_BUNDLE_ENTRIES) {
        throw new StreamingValidationError(
          "bundle_too_many_entries",
          "Bundle contains more than 100000 entries",
        );
      }
      totalBytes += entry.header.size ?? 0;
      assertBundleFits(totalBytes, budget);
      if (entry.header.type !== "file" && entry.header.type !== "symlink") {
        entry.body.resume();
        continue;
      }
      const path = entry.header.name;
      const declared = expected.get(path);
      if (!declared || seen.has(path)) {
        throw new StreamingValidationError(
          "manifest_mismatch",
          `Unexpected or duplicate archive entry: ${path}`,
          path,
        );
      }
      seen.add(path);
      if (entry.header.type === "symlink" || declared.linkTarget !== null) {
        verifySymlinkEntry({ entry, expectedEntry: declared });
      } else {
        await pipeline(
          entry.body,
          createHashVerifier({ ...declared, archivePath: path }),
          new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }),
        );
      }
    }
    if (seen.size !== expected.size) {
      throw new StreamingValidationError(
        "manifest_mismatch",
        "Bundle is missing declared files",
      );
    }
    return await analyzeImportAsync({ manifest, pathResolver });
  } catch (err) {
    if (err instanceof StreamingValidationError) {
      return {
        can_import: false,
        validation: {
          is_valid: false as const,
          errors: [
            {
              code: err.code,
              message: err.message,
              ...(err.archivePath && { path: err.archivePath }),
            },
          ],
        },
      };
    }
    throw err;
  } finally {
    await entries.return();
    source.destroy();
  }
}
