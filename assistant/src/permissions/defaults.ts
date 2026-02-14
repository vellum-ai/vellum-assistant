import { join } from 'node:path';
import { getRootDir } from '../util/platform.js';

export interface DefaultRuleTemplate {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: 'allow' | 'deny' | 'ask';
  priority: number;
}

/** Tools that directly access the filesystem by path. */
const FILE_TOOLS = ['file_read', 'file_write', 'file_edit'] as const;
const HOST_FILE_TOOLS = ['host_file_read', 'host_file_write', 'host_file_edit'] as const;
const COMPUTER_USE_TOOLS = [
  'cu_click',
  'cu_double_click',
  'cu_right_click',
  'cu_type_text',
  'cu_key',
  'cu_scroll',
  'cu_drag',
  'cu_wait',
  'cu_open_app',
  'cu_run_applescript',
  'cu_done',
  'cu_respond',
  'request_computer_control',
] as const;

/**
 * Returns default trust rules shipped with the assistant.
 * Computed at runtime so paths reflect the configured root directory.
 */
export function getDefaultRuleTemplates(): DefaultRuleTemplate[] {
  // Use forward slashes so minimatch patterns work on all platforms
  // (path.join produces backslashes on Windows, which minimatch treats as escapes).
  const protectedDir = join(getRootDir(), 'protected').replaceAll('\\', '/');

  const protectedFileRules = FILE_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-protected`,
    tool,
    pattern: `${tool}:${protectedDir}/**`,
    scope: 'everywhere',
    decision: 'ask' as const,
    priority: 1000,
  }));

  const hostFileRules = HOST_FILE_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-global`,
    tool,
    pattern: `${tool}:/**`,
    scope: 'everywhere',
    decision: 'ask' as const,
    priority: 50,
  }));

  // host_bash command candidates are raw commands ("ls", "npm test"), so the
  // global default ask rule uses "**" (globstar) instead of a "tool:*" prefix
  // because commands often contain "/" (e.g. "cat /etc/hosts").
  const hostShellRule: DefaultRuleTemplate = {
    id: 'default:ask-host_bash-global',
    tool: 'host_bash',
    pattern: '**',
    scope: 'everywhere',
    decision: 'ask',
    priority: 50,
  };

  const computerUseRules = COMPUTER_USE_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-global`,
    tool,
    pattern: `${tool}:*`,
    scope: 'everywhere',
    decision: 'ask' as const,
    priority: 1000,
  }));

  return [...protectedFileRules, ...hostFileRules, hostShellRule, ...computerUseRules];
}
