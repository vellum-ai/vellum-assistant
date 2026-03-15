/**
 * Output file scanner for CES workspace copyback.
 *
 * Before any command output file is copied back into the assistant-visible
 * workspace, it is scanned for:
 *
 * 1. **Exact secret matches** — The file content is checked against a set
 *    of known secret values that were injected into the command environment.
 *    If any secret appears verbatim in the output, copyback is rejected.
 *
 * 2. **Auth-bearing config artifacts** — Common configuration file patterns
 *    that typically contain credentials (e.g. `.netrc`, AWS credentials files,
 *    GitHub token files) are detected by filename and content heuristics.
 *
 * Both checks are conservative: false positives are acceptable (the user can
 * explicitly re-request the file), but false negatives are not.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputScanResult {
  /** Whether the file passed all scans and is safe to copy back. */
  safe: boolean;
  /** List of reasons the file was rejected (empty when safe). */
  violations: string[];
}

// ---------------------------------------------------------------------------
// Auth-bearing config artifact patterns
// ---------------------------------------------------------------------------

/**
 * Filenames (basenames) that are known to contain credentials in their
 * standard format. Matched case-insensitively.
 */
const AUTH_BEARING_FILENAMES: ReadonlySet<string> = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".docker/config.json",
  "credentials",          // AWS ~/.aws/credentials
  "config.json",          // Docker, various
  ".git-credentials",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
]);

/**
 * Content patterns that indicate auth-bearing config artifacts.
 * Each entry is a regex tested against file content.
 */
const AUTH_BEARING_CONTENT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  description: string;
}> = [
  {
    pattern: /machine\s+\S+\s+login\s+\S+\s+password\s+\S+/i,
    description: "netrc-format credentials (machine/login/password)",
  },
  {
    pattern: /\[default\]\s*\n\s*aws_access_key_id\s*=/i,
    description: "AWS credentials file format",
  },
  {
    pattern: /aws_secret_access_key\s*=\s*\S+/i,
    description: "AWS secret access key in config",
  },
  {
    pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
    description: "PEM private key",
  },
  {
    pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/,
    description: "OpenSSH private key",
  },
  {
    pattern: /"auth"\s*:\s*"[A-Za-z0-9+/=]{20,}"/,
    description: "Docker registry auth token",
  },
  {
    pattern: /\/\/[^:]+:_authToken\s*=\s*\S+/,
    description: "npm registry auth token",
  },
  {
    pattern: /password\s*=\s*\S+/i,
    description: "Plain-text password in config file",
  },
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan a file's content for secret leakage before allowing copyback.
 *
 * @param filename   — The basename of the output file (used for artifact detection).
 * @param content    — The raw file content (string or Buffer).
 * @param secrets    — Set of known secret values that were injected into the
 *                     command's environment. Each value is checked for verbatim
 *                     presence in the file content.
 *
 * @returns A {@link OutputScanResult} indicating whether the file is safe.
 */
export function scanOutputFile(
  filename: string,
  content: string | Buffer,
  secrets: ReadonlySet<string>,
): OutputScanResult {
  const violations: string[] = [];
  const contentStr =
    typeof content === "string" ? content : content.toString("utf-8");

  // -- Check 1: Exact secret matches
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (contentStr.includes(secret)) {
      // Don't include the actual secret in the violation message
      violations.push(
        `File contains an exact match of a credential value ` +
          `(${secret.length} chars). Secrets must not leak into command outputs.`,
      );
    }
  }

  // -- Check 2: Auth-bearing filename detection
  const lowerFilename = filename.toLowerCase();
  const basenameOnly = lowerFilename.includes("/")
    ? lowerFilename.slice(lowerFilename.lastIndexOf("/") + 1)
    : lowerFilename;

  if (AUTH_BEARING_FILENAMES.has(basenameOnly)) {
    violations.push(
      `Filename "${filename}" matches a known auth-bearing config artifact. ` +
        `These files commonly contain credentials and cannot be copied back.`,
    );
  }

  // -- Check 3: Auth-bearing content pattern detection
  for (const { pattern, description } of AUTH_BEARING_CONTENT_PATTERNS) {
    if (pattern.test(contentStr)) {
      violations.push(
        `File content matches auth-bearing pattern: ${description}. ` +
          `Output files containing credential patterns cannot be copied back.`,
      );
    }
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}
