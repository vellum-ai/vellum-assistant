/**
 * Merge helper for `data/credentials/metadata.json` on bundle import.
 *
 * The credential metadata file lists the credentials known to the assistant
 * (service, field, policy, timestamps) and is used by the gateway's
 * `readServiceCredentials` to decide whether a service is "configured".
 * The VELLUM spec requires all four `vellum:*` fields (`platform_base_url`,
 * `assistant_api_key`, `platform_assistant_id`, `webhook_secret`) to be
 * present in metadata before the gateway will even look up their values in
 * CES.
 *
 * On a local→platform teleport, the bundle carries the SOURCE's metadata
 * (no `vellum:*` entries, since the source is local), and a naive overwrite
 * would wipe out the `vellum:*` entries that Django's post-hatch
 * provisioning just wrote on the TARGET. This module merges bundle and live
 * metadata with one rule:
 *
 *   - Drop `service === "vellum"` entries the bundle tries to ship
 *     (defense-in-depth — they represent the source's identity, not the
 *     target's). This mirrors the CES-side filter in migration-routes.ts.
 *   - Preserve every `service === "vellum"` entry the target already has.
 *   - Import bundle entries for every other service normally (user OAuth,
 *     channel credentials).
 *
 * Malformed input (missing file, unparseable JSON, unrecognized schema) is
 * handled by the callers: they should treat "no live metadata" as no
 * preservation needed, and leave the bundle's file untouched if its schema
 * can't be merged cleanly.
 */

const VELLUM_SERVICE = "vellum";

interface MetadataRecord {
  credentialId: string;
  service: string;
  field: string;
  [key: string]: unknown;
}

interface MetadataFile {
  version?: number;
  credentials?: unknown[];
  [key: string]: unknown;
}

function isRecord(value: unknown): value is MetadataRecord {
  if (typeof value !== "object" || value == null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.credentialId === "string" &&
    typeof r.service === "string" &&
    typeof r.field === "string"
  );
}

function parseMetadata(json: string | null | undefined): MetadataFile | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as MetadataFile;
  } catch {
    return null;
  }
}

function extractVellumRecords(file: MetadataFile | null): MetadataRecord[] {
  if (!file || !Array.isArray(file.credentials)) return [];
  return file.credentials
    .filter(isRecord)
    .filter((r) => r.service === VELLUM_SERVICE);
}

/**
 * Merge the bundle's metadata.json content with any `vellum:*` entries
 * present in the target's live metadata.json.
 *
 * Returns the merged JSON string, preserving the bundle's schema version
 * and formatting (2-space indent). If the bundle's JSON is unparseable the
 * original input is returned unchanged — we never want to corrupt the
 * bundle's file by emitting an empty or restructured payload.
 *
 * If the live JSON is unparseable or missing, the bundle's file is returned
 * verbatim (no preservation possible — nothing to preserve).
 */
export function mergeMetadataPreservingVellum(
  bundleJson: string,
  liveJson: string | null,
): string {
  const bundle = parseMetadata(bundleJson);
  if (!bundle) return bundleJson;

  const preservedVellum = extractVellumRecords(parseMetadata(liveJson));

  const bundleCredentials = Array.isArray(bundle.credentials)
    ? bundle.credentials.filter(isRecord)
    : [];

  // Drop any `service === "vellum"` entries from the bundle (defense-in-depth).
  const filteredBundle = bundleCredentials.filter(
    (r) => r.service !== VELLUM_SERVICE,
  );

  // Union: bundle non-vellum entries + target vellum entries. If the
  // preserved list happens to collide with a bundle entry on credentialId,
  // the preserved version wins (it belongs to the target's live identity).
  const merged = [...filteredBundle, ...preservedVellum];

  const output: MetadataFile = {
    ...bundle,
    credentials: merged,
  };

  return JSON.stringify(output, null, 2);
}

/** @internal For direct use by tests. */
const _internal = {
  VELLUM_SERVICE,
  parseMetadata,
  extractVellumRecords,
};
