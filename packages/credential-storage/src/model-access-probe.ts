/**
 * Stored-credential model-access probe.
 *
 * Answers two questions a caller cannot answer without holding the secret:
 * does the credential stored under `account` still authenticate against the
 * provider, and does the provider's model listing include the models the
 * caller cares about. The credential is read from a `SecureKeyBackend`,
 * injected into a single outbound request, and never returned: the result
 * carries an outcome, the listed model ids, and a redacted error snippet.
 *
 * CES runs this next to the secure store so the credential never leaves the
 * sidecar. The caller supplies the request recipe (URL, static headers,
 * injection slot) because provider endpoint knowledge belongs with the
 * provider adapters. This module owns the parts that protect the secret:
 * scheme validation, no redirect following, bounded timeout and body size,
 * and redaction of the credential out of everything it hands back.
 */

import type { SecureKeyBackend } from "./index.js";

/**
 * Where the stored credential is injected into the outbound probe request.
 * Structurally identical to the `credentialInjection` wire contract in
 * `@vellumai/service-contracts`, which is what CES passes in.
 */
export type ProbeCredentialInjection =
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "query"; name: string };

export interface ModelAccessProbeRequest {
  /** Account name of the stored credential to probe with. */
  account: string;
  /** The provider's model-listing request, minus the credential. */
  request: {
    /** Absolute http(s) URL of the model-listing endpoint. */
    url: string;
    /** Static headers to send. Never carries credential material. */
    headers?: Record<string, string>;
    credentialInjection: ProbeCredentialInjection;
  };
  /** Model ids to check against the listing response. */
  models: string[];
}

/**
 * Whether the stored credential authenticated against the provider.
 *
 * - `valid`: the provider accepted the credential and returned a listing.
 * - `invalid`: the provider rejected the credential (401/403).
 * - `missing_credential`: nothing is stored under the account.
 * - `inconclusive`: the probe could not decide (network error, rate limit,
 *   provider 5xx, unparseable body).
 */
export type ProbeOutcome =
  "valid" | "invalid" | "missing_credential" | "inconclusive";

/**
 * Per-model verdict. `unknown` whenever the listing itself did not come back,
 * so a failed probe never reads as "model missing".
 */
export type ModelAccess = "accessible" | "not_accessible" | "unknown";

export interface ModelAccessProbeResult {
  outcome: ProbeOutcome;
  /** HTTP status returned by the provider, when the request completed. */
  status?: number;
  /** Redacted, truncated provider error text for a failed probe. */
  detail?: string;
  /** Model ids the credential can reach, as reported by the provider. */
  accessibleModels: string[];
  /** Verdict for each model the caller asked about. */
  models: Array<{ model: string; access: ModelAccess }>;
}

/** Outbound probe timeout: long enough for a cold provider, short enough to stay interactive. */
const PROBE_TIMEOUT_MS = 10_000;

/** Cap on the provider body read, so a hostile endpoint cannot exhaust memory. */
const MAX_BODY_CHARS = 1_000_000;

/** Cap on the error text echoed back to the caller. */
const MAX_DETAIL_CHARS = 300;

/**
 * Normalize a model id for comparison. Gemini lists models as
 * `models/gemini-3.1-flash-lite`, and ids are case-insensitive in practice
 * across providers.
 */
function normalizeModelId(id: string): string {
  return id
    .trim()
    .replace(/^models\//, "")
    .toLowerCase();
}

/** The trailing segment of a namespaced id (`google/gemini-3.1` gives `gemini-3.1`). */
function bareModelId(id: string): string {
  const normalized = normalizeModelId(id);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/**
 * Pull model ids out of a listing response. Covers the shapes the supported
 * providers use: OpenAI-style `{ data: [{ id }] }`, Gemini-style
 * `{ models: [{ name }] }`, and a bare array.
 */
export function extractModelIds(body: unknown): string[] {
  let entries: unknown[] = [];
  if (Array.isArray(body)) {
    entries = body;
  } else if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ["data", "models"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        entries = value;
        break;
      }
    }
  }

  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      ids.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.name ?? record.model;
    if (typeof id === "string" && id.length > 0) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Whether `model` appears in `listed`. Matches on the normalized id, then on
 * the bare id, so a namespaced listing (`google/gemini-3.1-flash-lite`) still
 * resolves a profile that names the model without its namespace.
 */
export function isModelListed(model: string, listed: string[]): boolean {
  const target = normalizeModelId(model);
  const bareTarget = bareModelId(model);
  return listed.some((candidate) => {
    const normalized = normalizeModelId(candidate);
    return normalized === target || bareModelId(candidate) === bareTarget;
  });
}

/** Remove every occurrence of the credential from text the caller will see. */
function stripCredential(text: string, credential: string): string {
  if (!credential) {
    return text;
  }
  return text.split(credential).join("[REDACTED]");
}

function verdicts(
  models: string[],
  access: ModelAccess,
): ModelAccessProbeResult["models"] {
  return models.map((model) => ({ model, access }));
}

export async function probeModelAccess(
  request: ModelAccessProbeRequest,
  backend: Pick<SecureKeyBackend, "get">,
): Promise<ModelAccessProbeResult> {
  const credential = await backend.get(request.account);
  if (credential === undefined || credential === "") {
    return {
      outcome: "missing_credential",
      accessibleModels: [],
      models: verdicts(request.models, "unknown"),
    };
  }

  let url: URL;
  try {
    url = new URL(request.request.url);
  } catch {
    return {
      outcome: "inconclusive",
      detail: "Probe URL is not a valid URL.",
      accessibleModels: [],
      models: verdicts(request.models, "unknown"),
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      outcome: "inconclusive",
      detail: "Probe URL must use http or https.",
      accessibleModels: [],
      models: verdicts(request.models, "unknown"),
    };
  }

  const headers: Record<string, string> = { ...request.request.headers };
  const injection = request.request.credentialInjection;
  if (injection.kind === "header") {
    headers[injection.name] = `${injection.prefix ?? ""}${credential}`;
  } else {
    url.searchParams.set(injection.name, credential);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      // A redirect would re-send the credential to a host the caller never
      // named, so the probe stops at the first hop and reports inconclusive.
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      outcome: "inconclusive",
      detail: stripCredential(
        err instanceof Error ? err.message : String(err),
        credential,
      ).slice(0, MAX_DETAIL_CHARS),
      accessibleModels: [],
      models: verdicts(request.models, "unknown"),
    };
  }

  const raw = (await response.text()).slice(0, MAX_BODY_CHARS);

  if (!response.ok) {
    // 401 and 403 are the provider saying the credential itself is the
    // problem. Everything else (429, 5xx, a redirect the probe refused to
    // follow) leaves the credential's validity undetermined.
    const detail = stripCredential(raw, credential)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_DETAIL_CHARS);
    const rejected = response.status === 401 || response.status === 403;
    return {
      outcome: rejected ? "invalid" : "inconclusive",
      status: response.status,
      ...(detail ? { detail } : {}),
      accessibleModels: [],
      models: verdicts(request.models, "unknown"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      outcome: "inconclusive",
      status: response.status,
      detail: "Provider returned a non-JSON model listing.",
      accessibleModels: [],
      models: verdicts(request.models, "unknown"),
    };
  }

  const accessibleModels = extractModelIds(parsed);
  if (accessibleModels.length === 0) {
    // The credential authenticated, but a listing this module cannot read
    // says nothing about model access, and reporting every model as
    // unreachable off an unrecognized shape would be a false diagnosis.
    return {
      outcome: "valid",
      status: response.status,
      detail: "Provider returned no model ids in a recognizable shape.",
      accessibleModels,
      models: verdicts(request.models, "unknown"),
    };
  }

  return {
    outcome: "valid",
    status: response.status,
    accessibleModels,
    models: request.models.map((model) => ({
      model,
      access: isModelListed(model, accessibleModels)
        ? ("accessible" as const)
        : ("not_accessible" as const),
    })),
  };
}
