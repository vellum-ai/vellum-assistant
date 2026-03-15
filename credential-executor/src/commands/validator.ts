/**
 * Secure command manifest validator.
 *
 * Validates that a {@link SecureCommandManifest} meets the CES security
 * invariants before it can be registered. Validation is fail-closed: any
 * structural issue, missing field, or policy violation results in rejection.
 *
 * Invariants enforced:
 *
 * 1. The entrypoint and bundleId must not be a denied binary.
 * 2. At least one command profile must be declared (no empty manifests).
 * 3. Each profile must have at least one allowed argv pattern.
 * 4. Denied subcommands and denied flags lists are checked for consistency.
 * 5. Auth adapter config must be structurally valid.
 * 6. `egressMode` must be explicitly declared.
 * 7. When `egressMode` is `proxy_required`, each profile must declare at
 *    least one allowed network target.
 * 8. When `egressMode` is `no_network`, profiles must not declare network
 *    targets (contradictory).
 * 9. Overbroad patterns (e.g. a single `<param...>` that matches anything)
 *    are rejected.
 */

import {
  validateAuthAdapterConfig,
  AuthAdapterType,
} from "./auth-adapters.js";
import {
  type SecureCommandManifest,
  type CommandProfile,
  type AllowedArgvPattern,
  type AllowedNetworkTarget,
  MANIFEST_SCHEMA_VERSION,
  EGRESS_MODES,
  EgressMode,
  isDeniedBinary,
  pathBasename,
} from "./profiles.js";

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  /** Whether the manifest passed all checks. */
  valid: boolean;
  /** List of human-readable error messages (empty when valid). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Top-level validator
// ---------------------------------------------------------------------------

/**
 * Validate a secure command manifest against all CES security invariants.
 *
 * Returns a {@link ValidationResult} with `valid: false` and a list of
 * error messages if any check fails. Validation is exhaustive — all
 * violations are reported, not just the first.
 */
export function validateManifest(
  manifest: SecureCommandManifest,
): ValidationResult {
  const errors: string[] = [];

  // -- Schema version
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(
      `Unsupported schema version "${manifest.schemaVersion}". Expected "${MANIFEST_SCHEMA_VERSION}".`,
    );
  }

  // -- Required string fields
  if (!manifest.bundleDigest || manifest.bundleDigest.trim().length === 0) {
    errors.push("bundleDigest is required and must be non-empty.");
  }
  if (!manifest.bundleId || manifest.bundleId.trim().length === 0) {
    errors.push("bundleId is required and must be non-empty.");
  }
  if (!manifest.version || manifest.version.trim().length === 0) {
    errors.push("version is required and must be non-empty.");
  }
  if (!manifest.entrypoint || manifest.entrypoint.trim().length === 0) {
    errors.push("entrypoint is required and must be non-empty.");
  }

  // -- Denied binary check (entrypoint basename and bundleId)
  if (manifest.entrypoint && isDeniedBinary(manifest.entrypoint)) {
    errors.push(
      `Entrypoint "${manifest.entrypoint}" (basename: "${pathBasename(manifest.entrypoint)}") is a structurally denied binary. ` +
        `Generic HTTP clients, interpreters, and shell trampolines cannot be secure command profiles.`,
    );
  }
  if (manifest.bundleId && isDeniedBinary(manifest.bundleId)) {
    errors.push(
      `bundleId "${manifest.bundleId}" matches a structurally denied binary name. ` +
        `Generic HTTP clients, interpreters, and shell trampolines cannot be secure command profiles.`,
    );
  }

  // -- Egress mode
  if (!manifest.egressMode) {
    errors.push(
      `egressMode is required. Valid values: ${EGRESS_MODES.join(", ")}.`,
    );
  } else if (!(EGRESS_MODES as readonly string[]).includes(manifest.egressMode)) {
    errors.push(
      `Invalid egressMode "${manifest.egressMode}". Valid values: ${EGRESS_MODES.join(", ")}.`,
    );
  }

  // -- Auth adapter
  if (!manifest.authAdapter) {
    errors.push("authAdapter is required.");
  } else {
    const adapterErrors = validateAuthAdapterConfig(manifest.authAdapter);
    for (const e of adapterErrors) {
      errors.push(`authAdapter: ${e}`);
    }

    // -- credential_process helperCommand denied binary check
    if (manifest.authAdapter.type === AuthAdapterType.CredentialProcess) {
      const helper = manifest.authAdapter.helperCommand;
      if (helper && helper.trim().length > 0) {
        // Reject shell metacharacters that could chain a denied binary
        // after an allowed one (e.g. "aws-vault exec ; curl ...").
        // Since helperCommand is executed via `sh -c`, these operators
        // allow arbitrary command chaining that bypasses the denylist.
        if (containsShellMetacharacters(helper)) {
          errors.push(
            `authAdapter: credential_process helperCommand contains shell metacharacters. ` +
              `Command chaining operators (;, &&, ||, |) and subshell expansion ($()) ` +
              `are not allowed in helperCommand because they can bypass the denied binary check.`,
          );
        }

        const firstWord = extractShellBinary(helper);
        const basename = pathBasename(firstWord);
        if (isDeniedBinary(firstWord)) {
          errors.push(
            `authAdapter: credential_process helperCommand starts with denied binary "${basename}". ` +
              `Generic HTTP clients, interpreters, and shell trampolines cannot be used as credential helpers.`,
          );
        }
      }
    }
  }

  // -- cleanConfigDirs key validation (defense-in-depth against path traversal)
  if (manifest.cleanConfigDirs) {
    for (const key of Object.keys(manifest.cleanConfigDirs)) {
      if (key.includes("..")) {
        errors.push(
          `cleanConfigDirs key "${key}" contains path traversal sequence "..". ` +
            `This is not allowed.`,
        );
      }
      if (key.trim().length === 0) {
        errors.push(
          `cleanConfigDirs contains an empty key.`,
        );
      }
    }
  }

  // -- Command profiles (must have at least one)
  if (
    !manifest.commandProfiles ||
    Object.keys(manifest.commandProfiles).length === 0
  ) {
    errors.push(
      "At least one command profile must be declared. " +
        "Secure command profiles cannot default to 'run any subcommand on this binary.'",
    );
  } else {
    for (const [profileName, profile] of Object.entries(
      manifest.commandProfiles,
    )) {
      const profileErrors = validateProfile(
        profileName,
        profile,
        manifest.egressMode,
      );
      errors.push(...profileErrors);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Profile-level validation
// ---------------------------------------------------------------------------

function validateProfile(
  profileName: string,
  profile: CommandProfile,
  egressMode: EgressMode | undefined,
): string[] {
  const errors: string[] = [];
  const prefix = `Profile "${profileName}"`;

  // -- Description
  if (!profile.description || profile.description.trim().length === 0) {
    errors.push(`${prefix}: description is required and must be non-empty.`);
  }

  // -- Allowed argv patterns (must have at least one)
  if (
    !profile.allowedArgvPatterns ||
    profile.allowedArgvPatterns.length === 0
  ) {
    errors.push(
      `${prefix}: at least one allowedArgvPattern is required. ` +
        "Profiles must explicitly declare what invocations are allowed.",
    );
  } else {
    for (const pattern of profile.allowedArgvPatterns) {
      const patternErrors = validateArgvPattern(prefix, pattern);
      errors.push(...patternErrors);
    }
  }

  // -- Denied subcommands (required — runtime iterates unconditionally)
  if (!profile.deniedSubcommands || !Array.isArray(profile.deniedSubcommands)) {
    errors.push(
      `${prefix}: deniedSubcommands is required and must be an array. ` +
        "Use an empty array if no subcommands need to be denied.",
    );
  } else {
    for (const sub of profile.deniedSubcommands) {
      if (!sub || sub.trim().length === 0) {
        errors.push(
          `${prefix}: deniedSubcommands contains an empty string.`,
        );
      }
    }
  }

  // -- Denied flags (optional)
  if (profile.deniedFlags) {
    for (const flag of profile.deniedFlags) {
      if (!flag || flag.trim().length === 0) {
        errors.push(`${prefix}: deniedFlags contains an empty string.`);
      }
      if (flag && !flag.startsWith("-")) {
        errors.push(
          `${prefix}: deniedFlags entry "${flag}" does not start with "-". ` +
            "Flags must start with a dash.",
        );
      }
    }
  }

  // -- Network targets vs egress mode consistency
  if (egressMode === EgressMode.ProxyRequired) {
    if (
      !profile.allowedNetworkTargets ||
      profile.allowedNetworkTargets.length === 0
    ) {
      errors.push(
        `${prefix}: egressMode is "proxy_required" but no allowedNetworkTargets are declared. ` +
          "Commands with network egress must declare their allowed network targets.",
      );
    } else {
      for (let i = 0; i < profile.allowedNetworkTargets.length; i++) {
        const target = profile.allowedNetworkTargets[i]!;
        const targetErrors = validateNetworkTarget(
          `${prefix}: allowedNetworkTargets[${i}]`,
          target,
        );
        errors.push(...targetErrors);
      }
    }
  }

  if (egressMode === EgressMode.NoNetwork) {
    if (
      profile.allowedNetworkTargets &&
      profile.allowedNetworkTargets.length > 0
    ) {
      errors.push(
        `${prefix}: egressMode is "no_network" but allowedNetworkTargets are declared. ` +
          "This is contradictory — remove network targets or change egressMode.",
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Network target validation
// ---------------------------------------------------------------------------

/**
 * Overbroad host patterns that effectively match everything.
 * These defeat the purpose of declaring allowed network targets.
 */
const OVERBROAD_HOST_PATTERNS: ReadonlySet<string> = new Set([
  "*",
  "*.*",
  "*.*.*",
  "*.*.*.*",
]);

/**
 * Validate a single {@link AllowedNetworkTarget} entry.
 *
 * Returns an array of error messages (empty if valid). Checks:
 * - `hostPattern` is non-empty
 * - `hostPattern` is not overbroad (e.g. `"*"`, `"*.*"`)
 * - `hostPattern` is either an exact hostname or a wildcard-subdomain pattern (`*.domain.tld`)
 * - `ports` (if specified) are valid (1–65535)
 * - `protocols` (if specified) are `"http"` or `"https"` only
 */
function validateNetworkTarget(
  prefix: string,
  target: AllowedNetworkTarget,
): string[] {
  const errors: string[] = [];

  // -- hostPattern must be non-empty
  if (!target.hostPattern || target.hostPattern.trim().length === 0) {
    errors.push(`${prefix}: hostPattern is required and must be non-empty.`);
    return errors; // Can't validate further without a pattern
  }

  const pattern = target.hostPattern;

  // -- Reject overbroad patterns
  if (OVERBROAD_HOST_PATTERNS.has(pattern)) {
    errors.push(
      `${prefix}: hostPattern "${pattern}" is overbroad and matches effectively any host. ` +
        "Use exact hostnames (e.g. \"api.github.com\") or wildcard-subdomain patterns (e.g. \"*.github.com\").",
    );
    return errors;
  }

  // -- Validate pattern shape: exact hostname or *.domain.tld
  if (pattern.includes("*")) {
    // Only *.domain.tld form is allowed
    if (!pattern.startsWith("*.") || pattern.indexOf("*", 1) !== -1) {
      errors.push(
        `${prefix}: hostPattern "${pattern}" uses an unsupported wildcard format. ` +
          "Only wildcard-subdomain patterns (\"*.domain.tld\") are allowed. " +
          "Wildcards in the middle or end of a hostname are not supported.",
      );
    } else {
      // Ensure the domain part after *. is non-empty and looks like a domain
      const domain = pattern.slice(2);
      if (!domain || domain.trim().length === 0) {
        errors.push(
          `${prefix}: hostPattern "${pattern}" has an empty domain after the wildcard prefix.`,
        );
      }
    }
  }

  // -- Validate ports
  if (target.ports) {
    for (const port of target.ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(
          `${prefix}: port ${port} is invalid. Ports must be integers between 1 and 65535.`,
        );
      }
    }
  }

  // -- Validate protocols
  if (target.protocols) {
    const validProtocols = new Set(["http", "https"]);
    for (const proto of target.protocols) {
      if (!validProtocols.has(proto)) {
        errors.push(
          `${prefix}: protocol "${proto}" is invalid. Only "http" and "https" are allowed.`,
        );
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Argv pattern validation
// ---------------------------------------------------------------------------

function validateArgvPattern(
  profilePrefix: string,
  pattern: AllowedArgvPattern,
): string[] {
  const errors: string[] = [];

  if (!pattern.name || pattern.name.trim().length === 0) {
    errors.push(
      `${profilePrefix}: argv pattern has no name. Each pattern must be named for audit logging.`,
    );
  }

  if (!pattern.tokens || pattern.tokens.length === 0) {
    errors.push(
      `${profilePrefix}: argv pattern "${pattern.name}" has no tokens. ` +
        "Empty patterns would match any invocation.",
    );
    return errors;
  }

  // Check for overbroad patterns: a single rest placeholder matches anything
  if (
    pattern.tokens.length === 1 &&
    isRestPlaceholder(pattern.tokens[0]!)
  ) {
    errors.push(
      `${profilePrefix}: argv pattern "${pattern.name}" contains only a rest placeholder ` +
        `("${pattern.tokens[0]}"). This would match any invocation and is too broad.`,
    );
  }

  // Rest placeholder must be last token
  for (let i = 0; i < pattern.tokens.length; i++) {
    const token = pattern.tokens[i]!;
    if (isRestPlaceholder(token) && i < pattern.tokens.length - 1) {
      errors.push(
        `${profilePrefix}: argv pattern "${pattern.name}" has a rest placeholder ` +
          `("${token}") at position ${i}, but rest placeholders must be the last token.`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Shell metacharacter detection (for helperCommand safety)
// ---------------------------------------------------------------------------

/**
 * Shell metacharacters that enable command chaining or subshell expansion.
 * Since helperCommand is executed via `sh -c`, these operators allow an
 * attacker to chain a denied binary after an allowed one, bypassing the
 * denylist check on the first token.
 *
 * Detected patterns:
 * - `;`  — command separator
 * - `&&` — logical AND
 * - `||` — logical OR
 * - `|`  — pipe (but not `||`)
 * - `$(`  — command substitution
 * - `` ` `` — backtick command substitution
 * - `\n` — newline (POSIX command separator, equivalent to `;`)
 * - `\r` — carriage return
 */
const SHELL_METACHAR_RE = /;|&&|\|\||(?<!\|)\|(?!\|)|\$\(|`|\n|\r/;

/**
 * Returns true if the command string contains shell metacharacters that
 * could be used for command chaining or subshell expansion.
 */
export function containsShellMetacharacters(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}

// ---------------------------------------------------------------------------
// Shell binary extraction (for helperCommand denylist checks)
// ---------------------------------------------------------------------------

/**
 * Regex matching shell variable assignments (KEY=VALUE) at the start of a
 * command. These are environment overrides and not the binary. Handles
 * bare values, single-quoted values, and double-quoted values.
 */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|(?:\\.|[^\s])*)\s+/;

/**
 * Extract the actual binary name from a shell command string, accounting for
 * leading env-var assignments (KEY=VALUE prefixes) and shell quoting around
 * the binary token. This is necessary because helperCommand is executed via
 * `sh -c`, so the shell resolves assignments and quotes before execution.
 *
 * Examples:
 *   "curl https://..."                → "curl"
 *   "'curl' https://..."              → "curl"
 *   "AWS_PROFILE=x curl ..."          → "curl"
 *   "AWS_PROFILE=x FOO=bar curl ..." → "curl"
 *   "/usr/bin/python3 script.py"      → "/usr/bin/python3"
 */
export function extractShellBinary(command: string): string {
  let remaining = command.trim();

  // Strip leading KEY=VALUE assignments
  let match: RegExpExecArray | null;
  while ((match = ENV_ASSIGNMENT_RE.exec(remaining)) !== null) {
    remaining = remaining.slice(match[0].length);
  }

  // Extract the first whitespace-delimited token
  const firstToken = remaining.split(/\s+/)[0] ?? remaining;

  // Strip surrounding quotes (single or double)
  return stripShellQuotes(firstToken);
}

/**
 * Remove surrounding single or double quotes from a token.
 * Only strips matching pairs at the boundaries (e.g., `'curl'` → `curl`).
 */
function stripShellQuotes(token: string): string {
  if (token.length >= 2) {
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) {
      return token.slice(1, -1);
    }
  }
  return token;
}

// ---------------------------------------------------------------------------
// Argv matching (used by the runtime to check commands against profiles)
// ---------------------------------------------------------------------------

/**
 * Returns true if the token is a single-value placeholder like `<name>`.
 */
function isPlaceholder(token: string): boolean {
  return token.startsWith("<") && token.endsWith(">") && !token.endsWith("...>");
}

/**
 * Returns true if the token is a rest placeholder like `<name...>`.
 */
function isRestPlaceholder(token: string): boolean {
  return token.startsWith("<") && token.endsWith("...>");
}

/**
 * Check if a concrete argv array matches an allowed argv pattern.
 *
 * Matching rules:
 * - Literal tokens must match exactly.
 * - `<name>` matches exactly one argument.
 * - `<name...>` matches one or more remaining arguments (must be last token).
 */
export function matchesArgvPattern(
  argv: readonly string[],
  pattern: AllowedArgvPattern,
): boolean {
  const { tokens } = pattern;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (isRestPlaceholder(token)) {
      // Rest placeholder: must have at least one remaining arg
      return argv.length > i;
    }

    // No more args but still have pattern tokens
    if (i >= argv.length) return false;

    if (isPlaceholder(token)) {
      // Single placeholder: matches any single value
      continue;
    }

    // Literal: must match exactly
    if (argv[i] !== token) return false;
  }

  // All pattern tokens consumed — argv must also be fully consumed
  return argv.length === tokens.length;
}

// ---------------------------------------------------------------------------
// Full command validation against a manifest
// ---------------------------------------------------------------------------

export interface CommandValidationResult {
  /** Whether the command is allowed. */
  allowed: boolean;
  /** The profile name that matched (undefined when rejected). */
  matchedProfile?: string;
  /** The pattern name that matched (undefined when rejected). */
  matchedPattern?: string;
  /** Human-readable reason for rejection (undefined when allowed). */
  reason?: string;
}

/**
 * Validate a concrete command invocation (argv array) against a manifest.
 *
 * Checks:
 * 1. The argv is non-empty.
 * 2. The argv does not contain any denied subcommands (across all profiles).
 * 3. The argv does not contain any denied flags (across all profiles).
 * 4. At least one profile's allowed argv patterns matches.
 *
 * This function does NOT re-validate the manifest itself — call
 * {@link validateManifest} separately during registration.
 */
export function validateCommand(
  manifest: SecureCommandManifest,
  argv: readonly string[],
): CommandValidationResult {
  if (argv.length === 0) {
    return {
      allowed: false,
      reason: "Empty argv — no command to validate.",
    };
  }

  // Collect all denied subcommands and flags across profiles
  const allDeniedSubcommands = new Set<string>();
  const allDeniedFlags = new Set<string>();

  for (const profile of Object.values(manifest.commandProfiles)) {
    for (const sub of profile.deniedSubcommands) {
      allDeniedSubcommands.add(sub);
    }
    if (profile.deniedFlags) {
      for (const flag of profile.deniedFlags) {
        allDeniedFlags.add(flag);
      }
    }
  }

  // Check denied subcommands (match against first N tokens of argv)
  for (const denied of allDeniedSubcommands) {
    const deniedParts = denied.split(/\s+/);
    if (deniedParts.length <= argv.length) {
      const match = deniedParts.every((part, i) => argv[i] === part);
      if (match) {
        return {
          allowed: false,
          reason: `Subcommand "${denied}" is explicitly denied.`,
        };
      }
    }
  }

  // Check denied flags — also handle --flag=value combined tokens
  for (const arg of argv) {
    if (allDeniedFlags.has(arg)) {
      return {
        allowed: false,
        reason: `Flag "${arg}" is explicitly denied.`,
      };
    }

    // Handle --flag=value form: extract the flag prefix before '='
    if (arg.startsWith("-") && arg.includes("=")) {
      const flagPrefix = arg.slice(0, arg.indexOf("="));
      if (allDeniedFlags.has(flagPrefix)) {
        return {
          allowed: false,
          reason: `Flag "${flagPrefix}" is explicitly denied (via "${arg}").`,
        };
      }
    }
  }

  // Try to match against allowed argv patterns in each profile
  for (const [profileName, profile] of Object.entries(
    manifest.commandProfiles,
  )) {
    for (const pattern of profile.allowedArgvPatterns) {
      if (matchesArgvPattern(argv, pattern)) {
        return {
          allowed: true,
          matchedProfile: profileName,
          matchedPattern: pattern.name,
        };
      }
    }
  }

  return {
    allowed: false,
    reason:
      "Command argv does not match any allowed pattern in any profile.",
  };
}
