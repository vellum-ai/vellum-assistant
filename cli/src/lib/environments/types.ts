/**
 * Environment type definitions. Environments are deployment targets with
 * their own platform backend and their own isolated on-host state. See the
 * "Coexisting environments" design doc for the full model.
 */

/**
 * Per-service default port set. Phase 5 (per-environment port offsets) is
 * deferred from MVP, so today every environment uses the same port set. The
 * shape exists so the rest of the stack can call `getDefaultPorts(env)` and
 * gain per-env offsets later without changing any call sites.
 */
export interface PortMap {
  daemon: number;
  gateway: number;
  qdrant: number;
  ces: number;
  outboundProxy: number;
  tcp: number;
}

/**
 * A resolved environment definition. Required fields are `name` and
 * `platformUrl`. All other fields are optional and declared upfront — new
 * fields are additive, never breaking. `name` is intentionally typed as
 * `string` (not `keyof SEEDS`) so custom environments can be represented by
 * future layers (user config file, ad-hoc env vars, etc.).
 */
export interface EnvironmentDefinition {
  name: string;
  platformUrl: string;

  /**
   * Override for the platform URL the assistant process itself uses. Only
   * differs from `platformUrl` when the assistant runs in a different network
   * namespace than the host (e.g. Docker on macOS, where the host's localhost
   * is reached via `host.docker.internal`). Falls back to `platformUrl` when
   * unset.
   */
  assistantPlatformUrl?: string;

  /** Human-readable label for UI surfaces. */
  displayName?: string;

  /** Hint for UI surfaces that want to tint or badge their display. */
  tintColor?: string;

  /** Per-service port overrides merged on top of defaults. */
  portsOverride?: Partial<PortMap>;

  /** Override for the XDG config directory. */
  configDirOverride?: string;

  /**
   * Override for the directory containing the lockfile. Populated by the
   * resolver from `VELLUM_LOCKFILE_DIR` (an existing e2e test escape hatch)
   * so path helpers don't read env vars directly.
   */
  lockfileDirOverride?: string;
}
