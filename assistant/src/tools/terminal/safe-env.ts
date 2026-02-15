/**
 * Environment variables that are safe to pass through to child processes.
 * Everything else (API keys, tokens, credentials) is stripped to prevent
 * accidental leakage via agent-spawned commands.
 *
 * Shared by the sandbox bash tool and the evaluate_typescript_code tool.
 */
const SAFE_ENV_VARS = [
  'PATH',
  'HOME',
  'TERM',
  'LANG',
  'EDITOR',
  'SHELL',
  'USER',
  'TMPDIR',
  'LC_ALL',
  'LC_CTYPE',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
  'COLORTERM',
  'TERM_PROGRAM',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GPG_TTY',
  'GNUPGHOME',
] as const;

export function buildSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key] != null) {
      env[key] = process.env[key]!;
    }
  }
  return env;
}
