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
}

export function serializeManifest(manifest: AppManifest): string {
  return JSON.stringify(manifest, null, 2);
}
