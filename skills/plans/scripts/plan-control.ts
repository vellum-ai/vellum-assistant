#!/usr/bin/env bun

/**
 * Confirmed task-plan client for the Autonomous Execution Engine.
 *
 * Sub-commands:
 *   create --goal <text> --steps-json <json>  — `POST /v1/plans`
 *   list                                      — `GET /v1/plans`
 *   get <id>                                  — `GET /v1/plans/:id`
 *   update-status <plan-id> <step-id> --status <status>
 *                                             — `POST /v1/plans/:id/steps/:stepId/status`
 *   cancel <id> [--reason]                    — `POST /v1/plans/:id/cancel`
 *
 * Auth follows the same fallback chain as `recent-context.ts` in the
 * perception skill: prefer caller-provided token / env-injected token,
 * fall back to a short-lived locally-signed gateway-ingress JWT when
 * the script runs inside the daemon's skill environment.
 */

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ParsedArgs {
  subcommand: string;
  positional: string[];
  flags: Record<string, string>;
}

type StepInput =
  | string
  | {
      name: string;
      input?: Record<string, unknown>;
    };

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      "Usage: plan-control <create|list|get|update-status|cancel> [args]",
    );
  }
  const subcommand = argv[0]!;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      flags[arg.slice(2)] = next;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { subcommand, positional, flags };
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function runtimeUrl(flags: Record<string, string>): string {
  const value =
    flags["runtime-url"] ??
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

function token(flags: Record<string, string>): string | undefined {
  return (
    flags.token ??
    envValue("VELLUM_AUTH_TOKEN", "ASSISTANT_AUTH_TOKEN", "VELLUM_JWT")
  );
}

const CURRENT_POLICY_EPOCH = 1;
const DAEMON_PORT_FALLBACK = "7821";

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

function parseStepsJson(value: string): Array<{
  name: string;
  input?: Record<string, unknown>;
}> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("--steps-json must be a non-empty JSON array");
  }
  return parsed.map((step, index) => {
    const candidate = step as StepInput;
    if (typeof candidate === "string") {
      if (candidate.trim().length === 0) {
        throw new Error(`step ${index + 1} is empty`);
      }
      return { name: candidate.trim() };
    }
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.name === "string" &&
      candidate.name.trim().length > 0
    ) {
      const out: { name: string; input?: Record<string, unknown> } = {
        name: candidate.name.trim(),
      };
      if (candidate.input && typeof candidate.input === "object") {
        out.input = candidate.input;
      }
      return out;
    }
    throw new Error(
      `step ${index + 1} must be a string or object with a non-empty name`,
    );
  });
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

async function request(
  url: string,
  init: RequestInit,
  authToken?: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers: Record<string, string> = init.headers
    ? { ...(init.headers as Record<string, string>) }
    : {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function fetchWithFallback(
  baseUrl: string,
  authToken: string | undefined,
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; text: string }> {
  const first = await request(`${baseUrl}${path}`, init, authToken);
  if (first.ok || authToken || first.status !== 401) return first;
  const fallbackToken = mintLocalGatewayIngressToken();
  const runtimeBaseUrl = deriveRuntimeUrlFromGateway(baseUrl);
  if (!fallbackToken || !runtimeBaseUrl) return first;
  return await request(`${runtimeBaseUrl}${path}`, init, fallbackToken);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const baseUrl = runtimeUrl(parsed.flags);
  const authToken = token(parsed.flags);

  let result: { ok: boolean; status: number; text: string };
  let path: string;
  let init: RequestInit;
  switch (parsed.subcommand) {
    case "create": {
      const goal = parsed.flags.goal;
      const stepsJson = parsed.flags["steps-json"];
      if (!goal || !stepsJson) {
        throw new Error(
          "Usage: plan-control create --goal <goal> --steps-json '[\"step\"]'",
        );
      }
      path = "/v1/plans";
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          steps: parseStepsJson(stepsJson),
          ...(parsed.flags["scope-id"]
            ? { scopeId: parsed.flags["scope-id"] }
            : {}),
          ...(parsed.flags["conversation-id"]
            ? { conversationId: parsed.flags["conversation-id"] }
            : {}),
        }),
      };
      result = await fetchWithFallback(baseUrl, authToken, path, init);
      break;
    }
    case "list": {
      path = "/v1/plans";
      const url = new URL(`${baseUrl}${path}`);
      if (parsed.flags["scope-id"])
        url.searchParams.set("scopeId", parsed.flags["scope-id"]);
      if (parsed.flags.limit) url.searchParams.set("limit", parsed.flags.limit);
      init = { method: "GET" };
      result = await request(url.toString(), init, authToken);
      if (!result.ok && !authToken && result.status === 401) {
        const fallbackToken = mintLocalGatewayIngressToken();
        const runtimeBaseUrl = deriveRuntimeUrlFromGateway(baseUrl);
        if (fallbackToken && runtimeBaseUrl) {
          const fallbackUrl = new URL(`${runtimeBaseUrl}${path}`);
          for (const [k, v] of url.searchParams.entries()) {
            fallbackUrl.searchParams.set(k, v);
          }
          result = await request(fallbackUrl.toString(), init, fallbackToken);
        }
      }
      break;
    }
    case "get": {
      const id = parsed.positional[0];
      if (!id) throw new Error("Usage: plan-control get <plan-id>");
      path = `/v1/plans/${id}`;
      init = { method: "GET" };
      result = await fetchWithFallback(baseUrl, authToken, path, init);
      break;
    }
    case "update-status": {
      const id = parsed.positional[0];
      const stepId = parsed.positional[1];
      const status = parsed.flags.status;
      if (!id || !stepId || !status) {
        throw new Error(
          "Usage: plan-control update-status <plan-id> <step-id> --status <status>",
        );
      }
      path = `/v1/plans/${id}/steps/${stepId}/status`;
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          ...(parsed.flags["blocked-reason"]
            ? { blockedReason: parsed.flags["blocked-reason"] }
            : {}),
        }),
      };
      result = await fetchWithFallback(baseUrl, authToken, path, init);
      break;
    }
    case "cancel": {
      const id = parsed.positional[0];
      if (!id) throw new Error("Usage: plan-control cancel <plan-id>");
      path = `/v1/plans/${id}/cancel`;
      init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          parsed.flags.reason ? { reason: parsed.flags.reason } : {},
        ),
      };
      result = await fetchWithFallback(baseUrl, authToken, path, init);
      break;
    }
    default:
      throw new Error(
        `Unknown subcommand: ${parsed.subcommand}. Use create, list, get, update-status, or cancel.`,
      );
  }

  if (!result.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed (${result.status}): ${result.text}`,
    );
  }
  try {
    console.log(JSON.stringify(JSON.parse(result.text), null, 2));
  } catch {
    console.log(result.text);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
