import { join } from 'node:path';
import { getRootDir } from '../util/platform.js';

export interface DefaultRuleTemplate {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: 'allow' | 'deny';
  priority: number;
}

/** Tools that directly access the filesystem by path. */
const FILE_TOOLS = ['file_read', 'file_write', 'file_edit'] as const;

/**
 * Returns default trust rules shipped with the assistant.
 * Computed at runtime so paths reflect the configured root directory.
 */
export function getDefaultRuleTemplates(): DefaultRuleTemplate[] {
  // Use forward slashes so minimatch patterns work on all platforms
  // (path.join produces backslashes on Windows, which minimatch treats as escapes).
  const protectedDir = join(getRootDir(), 'protected').replaceAll('\\', '/');

  return FILE_TOOLS.map((tool) => ({
    id: `default:deny-${tool}-protected`,
    tool,
    pattern: `${tool}:${protectedDir}/**`,
    scope: 'everywhere',
    decision: 'deny' as const,
    priority: 1000,
  }));
}
