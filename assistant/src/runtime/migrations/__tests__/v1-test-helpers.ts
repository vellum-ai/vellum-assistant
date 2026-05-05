/**
 * Shared test helpers for vbundle v1 manifest fixture builders.
 *
 * Most tests don't care about the specific values of the assistant identity,
 * origin, compatibility, or export-options blocks — they just need the
 * builder/validator to accept their fixtures. Centralizing the defaults
 * keeps every test from re-spelling the same six required option fields.
 */

import { randomUUID } from "node:crypto";

import type {
  BuildVBundleOptions,
  VBundleAssistantInfo,
  VBundleCompatibility,
  VBundleExportOptions,
  VBundleOriginInfo,
} from "../vbundle-builder.js";
import {
  computeManifestChecksum,
  type ManifestFileEntryType,
  type ManifestType,
} from "../vbundle-validator.js";

export interface DefaultV1Options {
  assistant: VBundleAssistantInfo;
  origin: VBundleOriginInfo;
  compatibility: VBundleCompatibility;
  exportOptions: VBundleExportOptions;
  secretsRedacted: boolean;
}

/**
 * Sensible defaults for the six caller-required v1 manifest options.
 *
 * `secretsRedacted` defaults to false to match the runtime's typical
 * "credentials included by design" path; tests that exercise the managed
 * cross-field refine override `origin.mode` and `secretsRedacted` directly.
 */
export function defaultV1Options(): DefaultV1Options {
  return {
    assistant: {
      id: "self",
      name: "Test",
      runtime_version: "0.0.0-test",
    },
    origin: {
      mode: "self-hosted-local",
    },
    compatibility: {
      min_runtime_version: "0.0.0-test",
      max_runtime_version: null,
    },
    exportOptions: {
      include_logs: false,
      include_browser_state: false,
      include_memory_vectors: false,
    },
    secretsRedacted: false,
  };
}

/**
 * Convenience: spread `defaultV1Options()` into a `BuildVBundleOptions`
 * with the supplied `files`. Saves repeating the spread at every call site.
 */
export function buildVBundleTestOptions(
  files: BuildVBundleOptions["files"],
  overrides: Partial<DefaultV1Options> = {},
): BuildVBundleOptions {
  return {
    files,
    ...defaultV1Options(),
    ...overrides,
  };
}

/**
 * Build a v1 ManifestType for tests, mirroring buildManifestObject() in
 * vbundle-builder.ts. Use this in test fixtures that need a synthetic
 * manifest rather than calling buildVBundle (e.g. cross-version compat
 * tests that need to mutate fields between emit and validate).
 *
 * Pass `overrides` to override any field after the defaults are applied —
 * useful for negative-path tests that exercise specific schema rejections.
 * `schema_version` is widened to `number` so negative tests can write 0/2/etc.
 * The checksum is computed on the merged shape so overrides take effect.
 */
export type BuildTestManifestOverrides = Partial<
  Omit<ManifestType, "schema_version">
> & { schema_version?: number };

export function buildTestManifest(input: {
  contents: ManifestFileEntryType[];
  overrides?: BuildTestManifestOverrides;
}): ManifestType {
  const base = defaultV1Options();
  const merged = {
    schema_version: 1,
    bundle_id: randomUUID(),
    created_at: new Date().toISOString(),
    assistant: base.assistant,
    origin: base.origin,
    compatibility: base.compatibility,
    contents: input.contents,
    checksum: "",
    secrets_redacted: base.secretsRedacted,
    export_options: base.exportOptions,
    ...(input.overrides ?? {}),
  } as ManifestType;
  return { ...merged, checksum: computeManifestChecksum(merged) };
}
