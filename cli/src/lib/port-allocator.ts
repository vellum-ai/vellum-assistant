import { createServer } from "net";

/**
 * Walks upward from `preferred` and returns the first host port that the
 * kernel will let us bind to. Used by `hatchDocker` to pick the gateway's
 * host-side port instead of always grabbing the env-default (e.g. 7830 /
 * 20100), which collides with any other local assistant — eval-spawned or
 * otherwise — already bound there.
 *
 * The previous design (`evals/src/lib/orphan-cleanup.ts`) tried to fix this
 * by sweeping dead eval-run resources before the next hatch. That only
 * helped when the conflict came from a prior eval run; an unrelated local
 * `vellum hatch` holding the port wedged the whole flow. Discovering an
 * open port at hatch time is the proper fix and lets us delete the cleanup
 * pre-flight entirely.
 *
 * Walks linearly from `preferred` upward rather than asking the kernel for
 * an arbitrary ephemeral port (`listen(0)`) so the resulting port stays
 * legible to operators — three local assistants land on N, N+1, N+2
 * instead of three random numbers in the 32768-60999 range.
 */
export async function findOpenPort(
  preferred: number,
  options: { maxAttempts?: number; host?: string } = {},
): Promise<number> {
  const maxAttempts = options.maxAttempts ?? 50;
  const host = options.host ?? "0.0.0.0";

  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error(
      `findOpenPort: preferred port ${preferred} is not a valid TCP port`,
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `findOpenPort: maxAttempts ${maxAttempts} must be a positive integer`,
    );
  }

  let lastError: Error | null = null;
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = preferred + offset;
    if (port > 65535) break;
    try {
      await probePort(port, host);
      return port;
    } catch (err) {
      lastError = err as Error;
      if (!isPortInUseError(err)) {
        // EACCES / EPERM / etc. are not "try the next port" signals — those
        // are configuration problems an operator needs to see immediately.
        throw err;
      }
    }
  }
  throw new Error(
    `findOpenPort: no open port in range [${preferred}, ${preferred + maxAttempts - 1}]` +
      (lastError ? ` (last error: ${lastError.message})` : ""),
  );
}

/**
 * Resolves if `port` on `host` can be bound right now. Rejects with the
 * server's `error` event (typically `EADDRINUSE`) otherwise. Always closes
 * the probe server before resolving so we don't leak the port we just
 * proved was free.
 */
function probePort(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const cleanup = (cb: () => void): void => {
      server.removeAllListeners();
      server.close(() => cb());
    };
    server.once("error", (err) => {
      // close() on a server that never listened is a no-op; calling it
      // anyway keeps cleanup uniform.
      cleanup(() => reject(err));
    });
    server.once("listening", () => {
      cleanup(() => resolve());
    });
    server.listen(port, host);
  });
}

function isPortInUseError(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EADDRINUSE" || code === "EADDRNOTAVAIL";
  }
  return false;
}
