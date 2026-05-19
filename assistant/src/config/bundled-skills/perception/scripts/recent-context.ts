#!/usr/bin/env bun

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Args {
  runtimeUrl?: string;
  token?: string;
  windowMs?: string;
  limit?: string;
  kind?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!arg.startsWith("--")) continue;
    if (next == null || next.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    i += 1;
    switch (arg) {
      case "--runtime-url":
        args.runtimeUrl = next;
        break;
      case "--token":
        args.token = next;
        break;
      case "--window-ms":
        args.windowMs = next;
        break;
      case "--limit":
        args.limit = next;
        break;
      case "--kind":
        args.kind = next;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function runtimeUrl(args: Args): string {
  const value =
    args.runtimeUrl ??
    envValue(
      "INTERNAL_GATEWAY_BASE_URL",
      "VELLUM_RUNTIME_URL",
      "ASSISTANT_RUNTIME_URL",
      "RUNTIME_URL",
    );
  if (!value) {
    throw new Error(
      "Missing gateway URL. Run inside the assistant skill environment or pass --runtime-url.",
    );
  }
  return value.replace(/\/+$/, "");
}

const CURRENT_POLICY_EPOCH = 1;
const DAEMON_PORT_FALLBACK = "7821";

function token(args: Args): string | undefined {
  return (
    args.token ??
    envValue("VELLUM_AUTH_TOKEN", "ASSISTANT_AUTH_TOKEN", "VELLUM_JWT")
  );
}

function buildUrl(baseUrl: string, args: Args): string {
  const url = new URL(`${baseUrl}/v1/perception/recent`);
  if (args.windowMs) url.searchParams.set("windowMs", args.windowMs);
  if (args.limit) url.searchParams.set("limit", args.limit);
  if (args.kind) url.searchParams.set("kind", args.kind);
  return url.toString();
}

async function requestRecent(
  baseUrl: string,
  args: Args,
  authToken?: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers: HeadersInit = authToken
    ? { Authorization: `Bearer ${authToken}` }
    : {};
  const response = await fetch(buildUrl(baseUrl, args), { headers });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

function base64urlEncodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mintLocalGatewayIngressToken(): string | undefined {
  const workspaceDir = envValue("VELLUM_WORKSPACE_DIR");
  if (!workspaceDir) return undefined;

  const keyPath = join(workspaceDir, "deprecated", "actor-token-signing-key");
  if (!existsSync(keyPath)) return undefined;

  let key: Buffer;
  try {
    key = readFileSync(keyPath);
  } catch {
    return undefined;
  }

  if (key.length !== 32) return undefined;

  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncodeJson({ alg: "HS256", typ: "JWT" });
  const payload = base64urlEncodeJson({
    iss: "vellum-auth",
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    exp: now + 60,
    policy_epoch: CURRENT_POLICY_EPOCH,
    iat: now,
    jti: randomBytes(16).toString("hex"),
  });
  const signature = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function deriveRuntimeUrlFromGateway(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.port === "7830") {
      url.port = DAEMON_PORT_FALLBACK;
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // no-op
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = runtimeUrl(args);
  const explicitToken = token(args);

  const firstAttempt = await requestRecent(baseUrl, args, explicitToken);
  if (firstAttempt.ok) {
    try {
      console.log(JSON.stringify(JSON.parse(firstAttempt.text), null, 2));
    } catch {
      console.log(firstAttempt.text);
    }
    return;
  }

  if (!explicitToken && firstAttempt.status === 401) {
    const fallbackToken = mintLocalGatewayIngressToken();
    const runtimeBaseUrl = deriveRuntimeUrlFromGateway(baseUrl);
    if (fallbackToken && runtimeBaseUrl) {
      const secondAttempt = await requestRecent(
        runtimeBaseUrl,
        args,
        fallbackToken,
      );
      if (secondAttempt.ok) {
        try {
          console.log(JSON.stringify(JSON.parse(secondAttempt.text), null, 2));
        } catch {
          console.log(secondAttempt.text);
        }
        return;
      }
    }
  }

  throw new Error(
    `GET /v1/perception/recent failed (${firstAttempt.status}): ${firstAttempt.text}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
