/**
 * CES auth adapter definitions for secure command profiles.
 *
 * Auth adapters describe how credentials are materialised into a command's
 * execution environment. Each adapter type has different security properties
 * and cleanup requirements.
 *
 * v1 adapter set:
 *
 * - `env_var`            — Inject credential as an environment variable.
 *                          Lifetime: process scope. Cleaned up on exit.
 * - `temp_file`          — Write credential to a temporary file and pass
 *                          the path via an env var. File is deleted after
 *                          command exits.
 * - `credential_process` — Spawn a helper process that prints the credential
 *                          to stdout (AWS credential_process pattern). The
 *                          helper runs inside CES and is never exposed to the
 *                          subprocess directly.
 */

// ---------------------------------------------------------------------------
// Auth adapter type discriminator
// ---------------------------------------------------------------------------

export const AuthAdapterType = {
  /** Inject credential value as an environment variable. */
  EnvVar: "env_var",
  /** Write credential to a temp file and set a path env var. */
  TempFile: "temp_file",
  /**
   * Spawn a credential helper process (AWS credential_process-style).
   * The helper stdout is captured and injected as an env var.
   */
  CredentialProcess: "credential_process",
} as const;

export type AuthAdapterType =
  (typeof AuthAdapterType)[keyof typeof AuthAdapterType];

/** All valid auth adapter type strings. */
export const AUTH_ADAPTER_TYPES: readonly AuthAdapterType[] = Object.values(
  AuthAdapterType,
) as AuthAdapterType[];

// ---------------------------------------------------------------------------
// Auth adapter config shapes
// ---------------------------------------------------------------------------

/**
 * Inject a credential directly as an environment variable.
 *
 * Example: `GH_TOKEN=<secret>` with `envVarName: "GH_TOKEN"`.
 */
export interface EnvVarAdapterConfig {
  type: typeof AuthAdapterType.EnvVar;
  /** Environment variable name where the credential value is injected. */
  envVarName: string;
  /**
   * Optional prefix prepended to the raw credential value before injection
   * (e.g. "Bearer " for OAuth tokens).
   */
  valuePrefix?: string;
}

/**
 * Write the credential to a temporary file and set an env var to the path.
 *
 * Example: `GOOGLE_APPLICATION_CREDENTIALS=/tmp/ces-xxx/svc.json`.
 * The temp file is created in a CES-managed ephemeral directory and deleted
 * after the command exits.
 */
export interface TempFileAdapterConfig {
  type: typeof AuthAdapterType.TempFile;
  /** Environment variable name pointing to the temp file path. */
  envVarName: string;
  /** File extension for the temp file (e.g. ".json", ".pem"). */
  fileExtension?: string;
  /**
   * File mode (octal) for the temp file. Defaults to 0o600 (owner-only
   * read/write). Must be <= 0o600.
   */
  fileMode?: number;
}

/**
 * Spawn a credential helper process, capture its stdout, and inject the
 * result as an env var.
 *
 * Example: AWS `credential_process` that emits JSON with temporary keys.
 * The helper command runs inside the CES process and is never exposed to
 * the child command.
 */
export interface CredentialProcessAdapterConfig {
  type: typeof AuthAdapterType.CredentialProcess;
  /** The helper command to run (e.g. "aws-vault exec <profile> --json"). */
  helperCommand: string;
  /** Environment variable name where the helper's stdout is injected. */
  envVarName: string;
  /** Timeout in milliseconds for the helper process. Defaults to 10000. */
  timeoutMs?: number;
}

/**
 * Discriminated union of all auth adapter configurations.
 */
export type AuthAdapterConfig =
  | EnvVarAdapterConfig
  | TempFileAdapterConfig
  | CredentialProcessAdapterConfig;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given string is a valid auth adapter type.
 */
export function isValidAuthAdapterType(value: string): value is AuthAdapterType {
  return (AUTH_ADAPTER_TYPES as readonly string[]).includes(value);
}

/**
 * Validate an auth adapter config shape. Returns a list of error messages
 * (empty array = valid).
 */
export function validateAuthAdapterConfig(
  config: AuthAdapterConfig,
): string[] {
  const errors: string[] = [];

  if (!isValidAuthAdapterType(config.type)) {
    errors.push(
      `Unknown auth adapter type "${config.type}". Valid types: ${AUTH_ADAPTER_TYPES.join(", ")}`,
    );
    return errors;
  }

  if (!config.envVarName || config.envVarName.trim().length === 0) {
    errors.push(`Auth adapter "${config.type}" requires a non-empty envVarName`);
  }

  switch (config.type) {
    case AuthAdapterType.TempFile:
      if (
        config.fileMode !== undefined &&
        (config.fileMode > 0o600 || (config.fileMode & 0o077) !== 0)
      ) {
        errors.push(
          `temp_file adapter fileMode must be <= 0600 (owner-only) with no group/other bits, got ${config.fileMode.toString(8)}`,
        );
      }
      break;

    case AuthAdapterType.CredentialProcess:
      if (!config.helperCommand || config.helperCommand.trim().length === 0) {
        errors.push(
          `credential_process adapter requires a non-empty helperCommand`,
        );
      }
      if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
        errors.push(
          `credential_process adapter timeoutMs must be positive, got ${config.timeoutMs}`,
        );
      }
      break;
  }

  return errors;
}
