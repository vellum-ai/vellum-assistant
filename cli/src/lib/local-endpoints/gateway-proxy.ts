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
