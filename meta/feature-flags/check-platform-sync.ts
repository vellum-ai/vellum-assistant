/**
 * Standalone Bun script that validates every feature flag key in the local
 * registry exists on the platform (via the public feature-flags endpoint).
 *
 * Usage:
 *   PLATFORM_API_URL=https://... bun run meta/feature-flags/check-platform-sync.ts
 *
 * Exit codes:
 *   0 — all registry flags found on the platform
 *   1 — missing flags, missing env var, or API error
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

// ---------------------------------------------------------------------------
// 1. Validate environment
// ---------------------------------------------------------------------------

const baseUrl = process.env.PLATFORM_API_URL;
if (!baseUrl) {
  console.error('Error: PLATFORM_API_URL environment variable is required but not set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Load local registry
// ---------------------------------------------------------------------------

interface RegistryFlag {
  key: string;
  [k: string]: unknown;
}

interface Registry {
  flags: RegistryFlag[];
}

const registryPath = join(import.meta.dirname ?? __dirname, 'feature-flag-registry.json');
const registryRaw = await readFile(registryPath, 'utf-8');
const registry: Registry = JSON.parse(registryRaw);
const registryKeys = new Set(registry.flags.map((f) => f.key));

// ---------------------------------------------------------------------------
// 3. Fetch flags from the platform API
// ---------------------------------------------------------------------------

const apiUrl = `${baseUrl.replace(/\/+$/, '')}/v1/feature-flags/`;

let response: Response;
try {
  response = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: Failed to reach the platform API at ${apiUrl}`);
  console.error(`  ${message}`);
  process.exit(1);
}

if (!response.ok) {
  const body = await response.text().catch(() => '(unable to read response body)');
  console.error(`Error: Platform API returned HTTP ${response.status}`);
  console.error(`  ${body}`);
  process.exit(1);
}

interface ApiResponse {
  flags: { key: string; [k: string]: unknown }[];
}

const apiData: ApiResponse = await response.json();
const apiKeys = new Set(apiData.flags.map((f) => f.key));

// ---------------------------------------------------------------------------
// 4. Compare
// ---------------------------------------------------------------------------

const missingKeys = [...registryKeys].filter((k) => !apiKeys.has(k));

if (missingKeys.length === 0) {
  console.log(`\u2713 All ${registryKeys.size} registry flags found on the platform`);
  process.exit(0);
} else {
  const list = missingKeys.map((k) => `  - ${k}`).join('\n');
  console.error(
    `\u2717 ${missingKeys.length} registry flag${missingKeys.length === 1 ? '' : 's'} not found on the platform:\n${list}\n\nAdd the missing flag${missingKeys.length === 1 ? '' : 's'} via Terraform in the vellum-assistant-platform repo.`,
  );
  process.exit(1);
}
