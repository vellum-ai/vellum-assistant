import { readdirSync, readFileSync, existsSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { getHooksDir } from '../util/platform.js';
import { loadHooksConfig } from './config.js';
import { getLogger } from '../util/logger.js';
import type { HookManifest, DiscoveredHook } from './types.js';

const log = getLogger('hooks-discovery');

const VALID_EVENTS = new Set<string>([
  'daemon-start', 'daemon-stop',
  'session-start', 'session-end',
  'pre-llm-call', 'post-llm-call',
  'pre-tool-execute', 'post-tool-execute',
  'permission-request', 'permission-resolve',
  'pre-message', 'post-message',
  'on-error',
]);

function isValidManifest(manifest: unknown): manifest is HookManifest {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const m = manifest as Record<string, unknown>;
  if (typeof m.name !== 'string' || !m.name) return false;
  if (typeof m.description !== 'string' || !m.description) return false;
  if (typeof m.version !== 'string' || !m.version) return false;
  if (typeof m.script !== 'string' || !m.script) return false;
  if (!Array.isArray(m.events) || m.events.length === 0) return false;
  for (const e of m.events) {
    if (typeof e !== 'string' || !VALID_EVENTS.has(e)) return false;
  }
  return true;
}

export function discoverHooks(hooksDir?: string): DiscoveredHook[] {
  const dir = hooksDir ?? getHooksDir();
  if (!existsSync(dir)) return [];

  const config = loadHooksConfig();
  const hooks: DiscoveredHook[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch (err) {
    log.warn({ err, dir }, 'Failed to read hooks directory');
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const hookDir = join(dir, entry.name);
    const manifestPath = join(hookDir, 'hook.json');
    if (!existsSync(manifestPath)) continue;

    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      log.warn({ err, hookDir }, 'Failed to parse hook manifest');
      continue;
    }

    if (!isValidManifest(manifest)) {
      log.warn({ hookDir }, 'Invalid hook manifest, skipping');
      continue;
    }

    const scriptPath = resolve(hookDir, manifest.script);
    if (!scriptPath.startsWith(hookDir + '/')) {
      log.warn({ hookDir, script: manifest.script }, 'Hook script path traversal detected, skipping');
      continue;
    }
    if (!existsSync(scriptPath)) {
      log.warn({ hookDir, script: manifest.script }, 'Hook script not found, skipping');
      continue;
    }

    hooks.push({
      name: entry.name,
      dir: hookDir,
      manifest,
      scriptPath,
      enabled: config.hooks[entry.name]?.enabled ?? false,
    });
  }

  return hooks.sort((a, b) => a.name.localeCompare(b.name));
}
