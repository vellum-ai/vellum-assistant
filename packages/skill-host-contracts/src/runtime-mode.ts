/**
 * Daemon runtime-mode type.
 *
 * `"docker"` describes a daemon running inside a container; `"bare-metal"`
 * describes a daemon running directly on the host. The runtime helper that
 * resolves this value from the environment lives in `assistant/src/runtime`
 * — this package intentionally holds only the type so it can be shared with
 * skill-side code without pulling in assistant-only dependencies.
 */

export type DaemonRuntimeMode = "bare-metal" | "docker";
