/**
 * Secure command profile manifest schema (v1).
 *
 * A secure command profile defines the complete execution boundary for a
 * credential-bearing command. Profiles are manifest-driven — there is no
 * default of "run any subcommand on this binary." Every allowed invocation
 * must be declared explicitly.
 *
 * Manifest fields:
 *
 * - **bundleDigest**       — SHA-256 digest of the command bundle (for
 *                            integrity verification).
 * - **bundleId**           — Unique identifier for the command bundle
 *                            (e.g. "gh-cli", "aws-cli").
 * - **version**            — Semantic version of the bundle.
 * - **entrypoint**         — Path to the executable within the bundle
 *                            (e.g. "bin/gh").
 * - **commandProfiles**    — Map of named profiles, each declaring allowed
 *                            argv grammar, denied subcommands, and network
 *                            targets.
 * - **authAdapter**        — How credentials are injected (env_var,
 *                            temp_file, or credential_process).
 * - **egressMode**         — Network egress enforcement mode. Must be
 *                            `proxy_required` unless the command has no
 *                            network needs.
 * - **cleanConfigDirs**    — List of config directories to mount as empty
 *                            tmpfs (prevents the command from reading host
 *                            config files that could contain secrets).
 */

import type { AuthAdapterConfig } from "./auth-adapters.js";

// ---------------------------------------------------------------------------
// Egress mode
// ---------------------------------------------------------------------------

/**
 * Network egress enforcement mode for a secure command profile.
 *
 * - `proxy_required`  — All network traffic MUST route through the CES
 *                        egress proxy. The command's environment is
 *                        configured with HTTP_PROXY/HTTPS_PROXY. Direct
 *                        connections are blocked.
 * - `no_network`      — The command has no network requirements. Any
 *                        network access is blocked entirely.
 *
 * There is intentionally no "direct" or "unrestricted" mode. Commands
 * that need network access must go through the egress proxy so CES can
 * enforce credential injection and audit logging.
 */
export const EgressMode = {
  ProxyRequired: "proxy_required",
  NoNetwork: "no_network",
} as const;

export type EgressMode = (typeof EgressMode)[keyof typeof EgressMode];

/** All valid egress mode strings. */
export const EGRESS_MODES: readonly EgressMode[] = Object.values(
  EgressMode,
) as EgressMode[];

// ---------------------------------------------------------------------------
// Allowed argv grammar
// ---------------------------------------------------------------------------

/**
 * Defines the allowed argument grammar for a command profile.
 *
 * Allowed patterns use a simple grammar:
 * - Literal strings match exactly (e.g. "api", "--json")
 * - `<param>` matches any single argument (positional placeholder)
 * - `<param...>` matches one or more remaining arguments (rest placeholder)
 *
 * Example: `["api", "<endpoint>", "--method", "<method>"]` allows
 * `gh api /repos --method GET` but not `gh auth login`.
 */
export interface AllowedArgvPattern {
  /**
   * Human-readable name for this pattern (e.g. "api-call", "list-repos").
   * Used in audit logs and error messages.
   */
  name: string;
  /**
   * Ordered sequence of argv tokens. Each token is either a literal
   * string or a placeholder (`<name>` or `<name...>`).
   */
  tokens: string[];
}

// ---------------------------------------------------------------------------
// Network target allowlist
// ---------------------------------------------------------------------------

/**
 * Declares a network target that the command is allowed to contact.
 */
export interface AllowedNetworkTarget {
  /** Host pattern (glob). E.g. "api.github.com", "*.amazonaws.com". */
  hostPattern: string;
  /** Allowed port(s). Null means any port. */
  ports?: number[];
  /** Allowed protocol(s). Defaults to ["https"]. */
  protocols?: Array<"http" | "https">;
}

// ---------------------------------------------------------------------------
// Command profile (single named profile within a manifest)
// ---------------------------------------------------------------------------

/**
 * A single named command profile within a manifest.
 *
 * Each profile defines a narrow slice of allowed behaviour for the command.
 * A manifest may contain multiple profiles (e.g. "read-repos" and
 * "create-issue" for the GitHub CLI).
 */
export interface CommandProfile {
  /** Human-readable description of what this profile allows. */
  description: string;

  /**
   * Allowed argv patterns. The command is rejected unless its arguments
   * match at least one pattern.
   */
  allowedArgvPatterns: AllowedArgvPattern[];

  /**
   * Subcommands that are explicitly denied even if they would otherwise
   * match an argv pattern. This is a safety net against overly broad
   * patterns.
   *
   * Each entry is matched against the first N argv tokens.
   */
  deniedSubcommands: string[];

  /**
   * Flags (argv tokens starting with `-`) that are explicitly denied.
   * Matched literally (e.g. "--exec", "-e").
   */
  deniedFlags?: string[];

  /**
   * Network targets this profile is allowed to contact. Only relevant
   * when egressMode is `proxy_required`.
   */
  allowedNetworkTargets?: AllowedNetworkTarget[];
}

// ---------------------------------------------------------------------------
// Secure command manifest (top-level)
// ---------------------------------------------------------------------------

/** Current manifest schema version. */
export const MANIFEST_SCHEMA_VERSION = "1" as const;

/**
 * v1 secure command manifest.
 *
 * This is the top-level schema that defines a complete execution boundary
 * for a credential-bearing command binary.
 */
export interface SecureCommandManifest {
  /** Manifest schema version. Must be "1". */
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;

  /**
   * SHA-256 hex digest of the command bundle. Used for integrity
   * verification before execution.
   */
  bundleDigest: string;

  /** Unique identifier for the command bundle (e.g. "gh-cli"). */
  bundleId: string;

  /** Semantic version of the bundle. */
  version: string;

  /**
   * Path to the executable entrypoint within the bundle
   * (e.g. "bin/gh", "bin/aws").
   */
  entrypoint: string;

  /**
   * Named command profiles. Each profile defines a narrow execution
   * boundary. Keyed by profile name.
   */
  commandProfiles: Record<string, CommandProfile>;

  /**
   * Auth adapter configuration describing how credentials are
   * materialised into the command's environment.
   */
  authAdapter: AuthAdapterConfig;

  /**
   * Network egress enforcement mode. Must be `proxy_required` for commands
   * that contact the network, or `no_network` for offline-only commands.
   */
  egressMode: EgressMode;

  /**
   * Config directories to mount as empty tmpfs during execution. Prevents
   * the command from reading host config files that might contain secrets.
   *
   * Map from source path pattern to a description.
   * E.g. `{ "~/.aws": "AWS CLI config", "~/.config/gh": "GitHub CLI config" }`.
   */
  cleanConfigDirs?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Denied binaries — structurally rejected as secure command profiles
// ---------------------------------------------------------------------------

/**
 * Binaries that are structurally banned from being registered as secure
 * command profiles. These are generic HTTP clients, interpreters, and
 * shell trampolines that would undermine the manifest-driven security
 * model.
 *
 * This list is checked against the entrypoint basename (the last path
 * segment) and against bundleId.
 */
export const DENIED_BINARIES: ReadonlySet<string> = new Set([
  // Generic HTTP clients
  "curl",
  "wget",
  "http",     // httpie
  "https",    // httpie alias
  "httpie",

  // Interpreters
  "python",
  "python3",
  "python3.10",
  "python3.11",
  "python3.12",
  "python3.13",
  "python3.14",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "lua",
  "php",

  // Multi-call umbrella binaries (contain wget, sh, etc. as subcommands)
  "busybox",
  "toybox",

  // Shell trampolines
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "env",    // /usr/bin/env can trampoline to any binary
  "xargs",  // can execute arbitrary commands
  "exec",
  "nohup",
  "strace",
  "ltrace",
]);

/**
 * Returns the basename of a path (last segment after the last `/`).
 */
export function pathBasename(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

/**
 * Check if a binary name (basename or full path) is in the denied set.
 * Matches against the basename portion of the path.
 */
export function isDeniedBinary(binaryNameOrPath: string): boolean {
  const basename = pathBasename(binaryNameOrPath);
  return DENIED_BINARIES.has(basename);
}
