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
