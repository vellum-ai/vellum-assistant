import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function resolveVersion(): string {
  const envVersion = process.env.APP_VERSION;
  if (envVersion && envVersion !== '0.0.0-dev') return envVersion;

  // Fall back to package.json version when env var is not set or is the dev placeholder.
  try {
    const pkgPath = join(import.meta.dirname ?? __dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.version && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // package.json missing or unreadable
  }

  return '0.0.0-dev';
}

// Version is embedded at compile time via --define in CI.
// Falls back to package.json version, then "0.0.0-dev" for local development.
export const APP_VERSION: string = resolveVersion();
