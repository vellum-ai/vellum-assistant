/**
 * Queries the Docker Engine API (over the local Unix socket) to inspect
 * the assistant container's state.  Used by the gateway to detect OOM
 * kills so it can return a meaningful error instead of a generic 502.
 *
 * The Docker socket must be mounted into the gateway container and the
 * ASSISTANT_CONTAINER_NAME env var must be set for this to work.
 * When either prerequisite is missing the helper silently returns null.
 */

import http from "node:http";

import { getLogger } from "../logger.js";

const log = getLogger("docker-health");

const DOCKER_SOCKET = "/var/run/docker.sock";
const INSPECT_TIMEOUT_MS = 2_000;

export type ContainerHealthStatus = {
  oomKilled: boolean;
  running: boolean;
  exitCode: number | null;
};

/**
 * Inspect the assistant container via the Docker Engine API.
 * Returns null when the Docker socket is unavailable or the container
 * name is not configured — callers should fall back to generic errors.
 */
export async function inspectAssistantContainer(): Promise<ContainerHealthStatus | null> {
  const containerName = process.env.ASSISTANT_CONTAINER_NAME;
  if (!containerName) return null;

  try {
    const data = await dockerGet(
      `/v1.43/containers/${encodeURIComponent(containerName)}/json`,
    );
    const state = data?.State as Record<string, unknown> | undefined;
    if (!state || typeof state !== "object") return null;

    return {
      oomKilled: state.OOMKilled === true,
      running: state.Running === true,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
    };
  } catch (err) {
    log.debug({ err }, "Docker inspect failed (socket may not be mounted)");
    return null;
  }
}

/**
 * Convenience: returns true when the assistant container was OOM-killed.
 * Returns false when Docker is unavailable or the container is healthy.
 */
export async function isAssistantOOMKilled(): Promise<boolean> {
  const status = await inspectAssistantContainer();
  return status?.oomKilled === true;
}

// ── low-level Docker Engine API helper ──────────────────────────────

function dockerGet(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(body) as Record<string, unknown>);
            } catch {
              reject(new Error("Docker API returned invalid JSON"));
            }
          } else {
            reject(
              new Error(
                `Docker API returned ${res.statusCode}: ${body.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(INSPECT_TIMEOUT_MS, () => {
      req.destroy(new Error("Docker inspect timed out"));
    });
    req.end();
  });
}
