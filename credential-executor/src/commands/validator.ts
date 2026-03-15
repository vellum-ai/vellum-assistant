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
} from "./auth-adapters.js";
import {
  type SecureCommandManifest,
  type CommandProfile,
  type AllowedArgvPattern,
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

  // Check denied flags
  for (const arg of argv) {
    if (allDeniedFlags.has(arg)) {
      return {
        allowed: false,
        reason: `Flag "${arg}" is explicitly denied.`,
      };
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
