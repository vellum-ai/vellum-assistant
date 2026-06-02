import fs from "node:fs";

const GATEWAY_PATTERN = /^(?:\/assistant)?\/__gateway\/(\d+)(\/.*)?$/;

export interface GatewayTarget {
  port: number;
  path: string;
}

export type GatewayParseResult =
  | { match: true; valid: true; target: GatewayTarget }
  | { match: true; valid: false }
  | { match: false };

export function parseGatewayUrl(pathname: string): GatewayParseResult {
  const match = pathname.match(GATEWAY_PATTERN);
  if (!match) return { match: false };

  const port = parseInt(match[1]!, 10);
  if (port < 1024 || port > 65535) return { match: true, valid: false };

  return { match: true, valid: true, target: { port, path: match[2] || "/" } };
}

/**
 * Verdict for a gateway-proxy URL, combining the URL parse with the
 * lockfile port-allowlist check into one decision a host can act on
 * without re-deriving the rules.
 *
 *   - `pass`          — not a gateway URL; the host serves it normally.
 *   - `invalid-port`  — a gateway URL whose port is outside 1024–65535.
 *   - `forbidden-port`— a well-formed gateway URL for a port that isn't
 *                       registered in the lockfile (the security
 *                       boundary: the proxy only reaches gateway ports
 *                       the user actually hatched, never arbitrary
 *                       loopback services).
 *   - `forward`       — forward to `127.0.0.1:{port}{path}`.
 */
export type GatewayProxyDecision =
  | { kind: "pass" }
  | { kind: "invalid-port" }
  | { kind: "forbidden-port"; port: number }
  | { kind: "forward"; target: GatewayTarget };

/**
 * Resolve a request pathname to a gateway-proxy verdict. Identical across every
 * host that proxies the data plane (the Vite dev middleware and the Electron
 * `app://` protocol handler).
 *
 * `getAllowedPorts` is a thunk (typically `() => readAllowedGatewayPorts(...)`)
 * so the lockfile is read only once a gateway URL is matched — the hot path of
 * static-asset and non-gateway requests never touches disk.
 */
export function resolveGatewayProxyTarget(
  pathname: string,
  getAllowedPorts: () => Set<number>,
): GatewayProxyDecision {
  const parsed = parseGatewayUrl(pathname);
  if (!parsed.match) return { kind: "pass" };
  if (!parsed.valid) return { kind: "invalid-port" };
  if (!getAllowedPorts().has(parsed.target.port)) {
    return { kind: "forbidden-port", port: parsed.target.port };
  }
  return { kind: "forward", target: parsed.target };
}

function addPortFromUrl(url: unknown, ports: Set<number>): void {
  if (typeof url !== "string") return;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return;
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      ports.add(port);
    }
  } catch {
    // malformed URL — skip
  }
}

export function readAllowedGatewayPorts(lockfilePaths: string[]): Set<number> {
  const ports = new Set<number>();
  for (const candidate of lockfilePaths) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const data = JSON.parse(raw) as {
        assistants?: Array<{
          gatewayUrl?: unknown;
          localUrl?: unknown;
          resources?: { gatewayPort?: unknown };
        }>;
      };
      const assistants = Array.isArray(data.assistants) ? data.assistants : [];
      for (const assistant of assistants) {
        if (!assistant) continue;
        addPortFromUrl(assistant.gatewayUrl, ports);
        addPortFromUrl(assistant.localUrl, ports);
        const gp = assistant.resources?.gatewayPort;
        if (typeof gp === "number" && Number.isInteger(gp) && gp >= 1024 && gp <= 65535) {
          ports.add(gp);
        }
      }
      if (ports.size > 0) return ports;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return new Set<number>();
    }
  }
  return ports;
}
