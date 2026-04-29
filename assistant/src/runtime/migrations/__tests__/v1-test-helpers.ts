/**
 * Shared test helpers for vbundle v1 manifest fixture builders.
 *
 * Most tests don't care about the specific values of the assistant identity,
 * origin, compatibility, or export-options blocks — they just need the
 * builder/validator to accept their fixtures. Centralizing the defaults
 * keeps every test from re-spelling the same six required option fields.
 */

import type {
  BuildVBundleOptions,
  VBundleAssistantInfo,
  VBundleCompatibility,
  VBundleExportOptions,
  VBundleOriginInfo,
} from "../vbundle-builder.js";

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
