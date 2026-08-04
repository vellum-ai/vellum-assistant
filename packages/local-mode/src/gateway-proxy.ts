import fs from "node:fs";

import { resolveCloud } from "./lockfile-contract";

const GATEWAY_PATTERN = /^(?:\/assistant)?\/__gateway\/(\d+)(\/.*)?$/;

const PAIRED_GATEWAY_PATTERN =
  /^(?:\/assistant)?\/__gateway-paired\/([^/]+)(\/.*)?$/;

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

export interface PairedGatewayTarget {
  assistantId: string;
  path: string;
}

export type PairedGatewayParseResult =
  | { match: true; valid: true; target: PairedGatewayTarget }
  | { match: true; valid: false }
  | { match: false };

export function parsePairedGatewayUrl(
  pathname: string,
): PairedGatewayParseResult {
  const match = pathname.match(PAIRED_GATEWAY_PATTERN);
  if (!match) {
    return { match: false };
  }

  let assistantId: string;
  try {
    assistantId = decodeURIComponent(match[1]!);
  } catch {
    // Malformed percent-encoding is an invalid parse, not a crash.
    return { match: true, valid: false };
  }

  return {
    match: true,
    valid: true,
    target: { assistantId, path: match[2] || "/" },
  };
}

/**
 * Verdict for a paired-gateway proxy URL (`/__gateway-paired/{assistantId}/*`),
 * combining the URL parse with the lockfile pairing-allowlist check into one
 * decision a host can act on without re-deriving the rules.
 *
 *   - `pass`: not a paired-gateway URL; the host serves it normally.
 *   - `unknown-assistant`: a paired-gateway URL whose id is malformed or not
 *     paired in the lockfile (the security boundary: the proxy only reaches
 *     gateways of entries the user actually imported, never arbitrary URLs).
 *   - `forward`: forward to `url` (the entry's recorded runtimeUrl with the
 *     request path appended).
 */
export type PairedGatewayProxyDecision =
  | { kind: "pass" }
  | { kind: "unknown-assistant" }
  | { kind: "forward"; url: string };

/**
 * Resolve a request pathname (plus query, when the host includes it) to a
 * paired-gateway proxy verdict. Identical across every host that proxies the
 * data plane, mirroring {@link resolveGatewayProxyTarget}.
 *
 * `getTargets` is a thunk (typically `() => readPairedGatewayTargets(...)`) so
 * the lockfile is read only once a paired-gateway URL is matched.
 */
export function resolvePairedGatewayProxyTarget(
  pathname: string,
  getTargets: () => Map<string, string>,
): PairedGatewayProxyDecision {
  const parsed = parsePairedGatewayUrl(pathname);
  if (!parsed.match) {
    return { kind: "pass" };
  }
  if (!parsed.valid) {
    return { kind: "unknown-assistant" };
  }
  const runtimeUrl = getTargets().get(parsed.target.assistantId);
  if (!runtimeUrl) {
    return { kind: "unknown-assistant" };
  }
  // Preserve the runtimeUrl's own path prefix (minus trailing slashes), then
  // append the request path and query.
  return {
    kind: "forward",
    url: `${runtimeUrl.replace(/\/+$/, "")}${parsed.target.path}`,
  };
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
          runtimeUrl?: unknown;
          resources?: { gatewayPort?: unknown };
        }>;
      };
      const assistants = Array.isArray(data.assistants) ? data.assistants : [];
      for (const assistant of assistants) {
        if (!assistant) continue;
        addPortFromUrl(assistant.gatewayUrl, ports);
        addPortFromUrl(assistant.localUrl, ports);
        // Docker entries record their published gateway as a loopback
        // `runtimeUrl` with no `resources` block; the loopback-hostname filter
        // in addPortFromUrl keeps remote runtimeUrls out of the allowlist.
        addPortFromUrl(assistant.runtimeUrl, ports);
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

/**
 * Read the paired-gateway allowlist from the lockfile: assistantId to the
 * recorded remote `runtimeUrl`, for entries whose resolved cloud is "paired"
 * and whose runtimeUrl parses as an absolute http(s) URL. Same error posture
 * as {@link readAllowedGatewayPorts}: tolerant of malformed JSON and entries,
 * reading the first lockfile path that yields targets.
 */
export function readPairedGatewayTargets(
  lockfilePaths: string[],
): Map<string, string> {
  const targets = new Map<string, string>();
  for (const candidate of lockfilePaths) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const data = JSON.parse(raw) as {
        assistants?: Array<Record<string, unknown> | null>;
      };
      const assistants = Array.isArray(data.assistants) ? data.assistants : [];
      for (const assistant of assistants) {
        if (!assistant || typeof assistant !== "object") {
          continue;
        }
        if (resolveCloud(assistant) !== "paired") {
          continue;
        }
        const { assistantId, runtimeUrl } = assistant;
        if (typeof assistantId !== "string" || assistantId === "") {
          continue;
        }
        if (typeof runtimeUrl !== "string") {
          continue;
        }
        try {
          const parsed = new URL(runtimeUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            continue;
          }
        } catch {
          continue;
        }
        targets.set(assistantId, runtimeUrl);
      }
      if (targets.size > 0) {
        return targets;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return new Map<string, string>();
      }
    }
  }
  return targets;
}
