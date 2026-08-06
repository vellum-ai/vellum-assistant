/**
 * Abstract-namespace Unix socket support (Linux only).
 *
 * An abstract socket name starts with a NUL byte and lives in the kernel's
 * network-namespace-scoped registry instead of the filesystem. All containers
 * in a Kubernetes pod share one network namespace, so abstract sockets give
 * cross-container IPC without a shared volume.
 *
 * Why: pod-shared emptyDir tmpfs mounts break gVisor snapshot restore
 * (https://github.com/google/gvisor/issues/13608). Abstract sockets are pure
 * in-sandbox kernel state — no mounts, no socket files — so managed pods can
 * drop the shared socket-dir volumes entirely.
 *
 * Opt-in via `VELLUM_IPC_ABSTRACT=1`, set by the platform pod template only
 * for managed deployments. Never enable it for local/bare-metal topologies:
 * the abstract namespace is global per network namespace, so two assistants
 * on one host would collide, and macOS does not support it at all.
 */

export const ABSTRACT_IPC_ENV = "VELLUM_IPC_ABSTRACT";

/** Prefix namespacing all Vellum abstract socket names within the pod. */
const ABSTRACT_NAME_PREFIX = "\0vellum-ipc/";

/** True when the environment opts this process into abstract-namespace IPC. */
export function isAbstractIpcEnabled(): boolean {
  const value = process.env[ABSTRACT_IPC_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * True when `path` is an abstract-namespace socket name rather than a
 * filesystem path. Callers must skip all filesystem operations (mkdir,
 * stat, unlink, chmod) on such paths — most `node:fs` functions throw on
 * NUL bytes.
 */
export function isAbstractSocketPath(path: string): boolean {
  return path.startsWith("\0");
}

/**
 * Build the abstract-namespace name for a socket file name, e.g.
 * `gateway.sock` → `\0vellum-ipc/gateway.sock`. Passing the result to
 * `net.Server#listen` / `net.connect` binds/connects in the abstract
 * namespace of the current network namespace.
 */
export function abstractSocketPath(fileName: string): string {
  return `${ABSTRACT_NAME_PREFIX}${fileName}`;
}
