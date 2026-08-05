import fs from "node:fs";

import type { TokenResult } from "./guardian-token";
import { isUsableRuntimeUrl, resolveCloud } from "./lockfile-contract";

const GATEWAY_PATTERN = /^(?:\/assistant)?\/__gateway\/(\d+)(\/.*)?$/;

const PAIRED_GATEWAY_PATTERN =
  /^(?:\/assistant)?\/__gateway-paired\/([^/?#]+)(\/.*)?$/;

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
  /** Pathname tail forwarded onto the runtimeUrl, without the query. */
  path: string;
  /** Query string including the leading `?`, or empty. */
  search: string;
}

export type PairedGatewayParseResult =
  | { match: true; valid: true; target: PairedGatewayTarget }
  | { match: true; valid: false }
  | { match: false };

/**
 * A tail containing a `.` or `..` path segment (raw or percent-encoded) could
 * escape the runtimeUrl's recorded path prefix on hosts that forward the tail
 * un-normalized, so it is an invalid parse. A segment whose percent-encoding
 * doesn't decode is rejected for the same reason: it can't be verified.
 */
function hasDotSegment(path: string): boolean {
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === "." || decoded === "..") {
      return true;
    }
  }
  return false;
}

/**
 * Parse a paired-gateway URL given as `pathname + search` (a `#fragment`
 * suffix is tolerated and dropped), so every host hands over the same shape
 * and the decision is host-independent.
 */
export function parsePairedGatewayUrl(url: string): PairedGatewayParseResult {
  const delimiter = url.search(/[?#]/);
  const pathname = delimiter === -1 ? url : url.slice(0, delimiter);
  const suffix = delimiter === -1 ? "" : url.slice(delimiter);
  const search = suffix.startsWith("?") ? (suffix.split("#")[0] ?? "") : "";

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

  const path = match[2] || "/";
  if (hasDotSegment(path)) {
    return { match: true, valid: false };
  }

  return {
    match: true,
    valid: true,
    target: { assistantId, path, search },
  };
}

/**
 * Verdict for a paired-gateway proxy URL (`/__gateway-paired/{assistantId}/*`),
 * combining the URL parse with the lockfile pairing-allowlist check into one
 * decision a host can act on without re-deriving the rules.
 *
 *   - `pass`: not a paired-gateway URL; the host serves it normally.
 *   - `reject`: a paired-gateway URL whose id is malformed, whose tail is a
 *     traversal attempt, or whose id is not paired in the lockfile (the
 *     security boundary: the proxy only reaches gateways of entries the user
 *     actually imported, never arbitrary URLs). Carries the status and
 *     message the host answers with, so hosts don't restate them.
 *   - `forward`: forward to `url` (the entry's recorded runtimeUrl with the
 *     request path and query appended). Carries the paired assistant id so
 *     the trusted host can resolve its guardian bearer.
 */
export type PairedGatewayProxyDecision =
  | { kind: "pass" }
  | { kind: "reject"; status: number; message: string }
  | {
      kind: "forward";
      url: string;
      runtimeUrl: string;
      assistantId: string;
    };

const PAIRED_GATEWAY_REJECTION: PairedGatewayProxyDecision = {
  kind: "reject",
  status: 403,
  message: "Assistant is not paired in lockfile",
};

/**
 * Resolve a request URL, given as `pathname + search`, to a paired-gateway
 * proxy verdict. Identical across every host that proxies the data plane,
 * mirroring {@link resolveGatewayProxyTarget}.
 *
 * `getTargets` is a thunk (typically `() => readPairedGatewayTargets(...)`) so
 * the lockfile is read only once a paired-gateway URL is matched.
 */
export function resolvePairedGatewayProxyTarget(
  url: string,
  getTargets: () => Map<string, string>,
): PairedGatewayProxyDecision {
  const parsed = parsePairedGatewayUrl(url);
  if (!parsed.match) {
    return { kind: "pass" };
  }
  if (!parsed.valid) {
    return PAIRED_GATEWAY_REJECTION;
  }
  const runtimeUrl = getTargets().get(parsed.target.assistantId);
  if (!runtimeUrl) {
    return PAIRED_GATEWAY_REJECTION;
  }
  // Preserve the runtimeUrl's own path prefix (minus trailing slashes), then
  // append the request path and query.
  return {
    kind: "forward",
    url: `${runtimeUrl.replace(/\/+$/, "")}${parsed.target.path}${parsed.target.search}`,
    runtimeUrl,
    assistantId: parsed.target.assistantId,
  };
}

/**
 * Strip renderer-controlled and browser-ambient headers from a paired forward
 * before the remote hop. The trusted host installs its own guardian bearer
 * after this function returns, so a renderer-provided `Authorization` header
 * can never select or override the credential sent upstream.
 */
export function sanitizePairedForwardHeaders(headers: Headers): void {
  const secFetchNames: string[] = [];
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("sec-fetch-")) {
      secFetchNames.push(name);
    }
  });
  for (const name of secFetchNames) {
    headers.delete(name);
  }
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("cookie");
  headers.delete("authorization");
  // Paired runtimeUrls are commonly ngrok tunnels; free-tier ngrok answers
  // browser User-Agents with an interstitial page (ERR_NGROK_6024) unless
  // this header is present. Harmless for every other target.
  headers.set("ngrok-skip-browser-warning", "true");
}

export type PairedGuardianTokenProvider = (
  assistantId: string,
  runtimeUrl: string,
) => Promise<TokenResult>;

export type PairedForwardAuthorizationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Replace renderer authorization with the paired credential owned by the host. */
export async function authorizePairedForwardHeaders(
  assistantId: string,
  runtimeUrl: string,
  headers: Headers,
  getGuardianToken: PairedGuardianTokenProvider,
): Promise<PairedForwardAuthorizationResult> {
  sanitizePairedForwardHeaders(headers);
  const result = await getGuardianToken(assistantId, runtimeUrl);
  if (!result.ok) {
    return result;
  }
  headers.set("authorization", `Bearer ${result.accessToken}`);
  return { ok: true };
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

type LockfileEntriesRead =
  | { kind: "ok"; assistants: unknown[] }
  | { kind: "missing" }
  | { kind: "unreadable" };

/**
 * Read one lockfile candidate's raw `assistants` array. `missing` is an
 * absent file; `unreadable` is any other read failure or malformed JSON. The
 * one read-loop body both gateway-proxy readers share; how a caller walks the
 * candidate list on `missing`/`unreadable` is its own posture.
 */
function readLockfileAssistantEntries(candidate: string): LockfileEntriesRead {
  let raw: string;
  try {
    raw = fs.readFileSync(candidate, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable" };
  }
  try {
    const data = JSON.parse(raw) as { assistants?: unknown };
    return {
      kind: "ok",
      assistants: Array.isArray(data.assistants) ? data.assistants : [],
    };
  } catch {
    return { kind: "unreadable" };
  }
}

export function readAllowedGatewayPorts(lockfilePaths: string[]): Set<number> {
  const ports = new Set<number>();
  for (const candidate of lockfilePaths) {
    const read = readLockfileAssistantEntries(candidate);
    if (read.kind === "missing") {
      continue;
    }
    if (read.kind === "unreadable") {
      return new Set<number>();
    }
    for (const entry of read.assistants) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const assistant = entry as {
        cloud?: unknown;
        project?: unknown;
        sshUser?: unknown;
        gatewayUrl?: unknown;
        localUrl?: unknown;
        runtimeUrl?: unknown;
        resources?: { gatewayPort?: unknown };
      };
      // A paired entry's gateway is remote by contract and reached through the
      // paired proxy; even a (rejected-on-import, but possibly pre-existing)
      // loopback runtimeUrl must never open the generic loopback proxy.
      if (resolveCloud(assistant) === "paired") {
        continue;
      }
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
    if (ports.size > 0) {
      return ports;
    }
  }
  return ports;
}

/**
 * Compute the paired-gateway allowlist from a lockfile's assistant entries:
 * assistantId to the recorded remote `runtimeUrl`, for entries whose resolved
 * cloud is "paired" and whose runtimeUrl is usable
 * ({@link isUsableRuntimeUrl}). Tolerant of malformed entries. Pure, so a host
 * holding an in-memory lockfile snapshot (e.g. the Electron lockfile watcher)
 * derives the allowlist without touching disk on the request path.
 */
export function pairedGatewayTargetsFromLockfile(lockfile: {
  assistants: readonly unknown[];
}): Map<string, string> {
  const targets = new Map<string, string>();
  for (const entry of lockfile.assistants) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const assistant = entry as Record<string, unknown>;
    if (resolveCloud(assistant) !== "paired") {
      continue;
    }
    const { assistantId, runtimeUrl } = assistant;
    if (typeof assistantId !== "string" || assistantId === "") {
      continue;
    }
    if (typeof runtimeUrl !== "string" || !isUsableRuntimeUrl(runtimeUrl)) {
      continue;
    }
    targets.set(assistantId, runtimeUrl);
  }
  return targets;
}

/**
 * Read the paired-gateway allowlist from the lockfile on disk
 * ({@link pairedGatewayTargetsFromLockfile} over the first readable
 * candidate). Path selection matches the unpair write path (`readRawLockfile`
 * in lockfile.ts): the first readable, parseable lockfile is authoritative
 * even when it yields no targets, so a pairing removed by an unpair write can
 * never survive in a stale fallback file's allowlist.
 */
export function readPairedGatewayTargets(
  lockfilePaths: string[],
): Map<string, string> {
  for (const candidate of lockfilePaths) {
    const read = readLockfileAssistantEntries(candidate);
    if (read.kind !== "ok") {
      continue;
    }
    return pairedGatewayTargetsFromLockfile({ assistants: read.assistants });
  }
  return new Map<string, string>();
}
