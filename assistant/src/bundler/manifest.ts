/**
 * Types and serialization for .vellumapp manifest files.
 */

export interface AppManifest {
  format_version: number; // always 1
  name: string;
  description?: string;
  icon?: string; // single emoji
  created_at: string; // ISO 8601
  created_by: string; // "vellum-assistant/{version}"
  entry: string; // "index.html"
  capabilities: string[]; // empty for MVP
  version?: string; // semver, defaults to "1.0.0"
  content_id?: string; // SHA-256 of "created_by:name", 16 hex chars
}

export function serializeManifest(manifest: AppManifest): string {
  return JSON.stringify(manifest, null, 2);
}
