/**
 * Share Feedback flow for the Chrome extension.
 *
 * Mirrors the macOS `LogReportFormView` / `LogExporter` contract so a
 * user (or support engineer) can ship a focused diagnostic bundle
 * back to the platform without leaving the popup. Submissions land at
 * `POST {apiBaseUrl}/v1/upload/feedback/` as `multipart/form-data` with
 * the same field shape the macOS app uses — `message`, `classification`,
 * `email`, `device_id`, `client_version`, optional `assistant_id`, and a
 * `logs_file` part containing the gzipped JSON bundle.
 *
 * Cloud submissions attach `X-Session-Token` and `Vellum-Organization-Id`
 * when available; self-hosted submissions ship unauthenticated, same as
 * the macOS app's behaviour when no session token exists. The platform
 * endpoint accepts both shapes.
 */

import { getClientId } from "./client-identity.js";
import {
  getStoredSession,
  getSelectedAssistant,
  type CloudSession,
  type SelectedAssistant,
} from "./cloud-auth.js";
import {
  getEventLog,
  getOperations,
  type EventLogEntry,
  type OperationEntry,
} from "./event-log.js";
import type { ExtensionEnvironment } from "./extension-environment.js";

export type FeedbackClassification = "bug_report" | "feature_request" | "other";

export interface FeedbackFormData {
  message: string;
  classification: FeedbackClassification;
  email: string;
  includeDiagnostics: boolean;
}

export interface EnvironmentContext {
  environment: ExtensionEnvironment;
  apiBaseUrl: string;
}

export interface BundleCollectionInputs {
  env: EnvironmentContext;
  mode: "cloud" | "self-hosted" | null;
  sseState: string;
  sseDetail?: Record<string, unknown> | null;
}

export interface DiagnosticBundle {
  collectedAt: string;
  extension: {
    version: string;
    environment: ExtensionEnvironment;
    apiBaseUrl: string;
    userAgent: string;
  };
  mode: "cloud" | "self-hosted" | null;
  assistant: { id: string; name: string } | null;
  organizationId: string | null;
  clientId: string;
  email: string | null;
  sse: {
    state: string;
    detail: Record<string, unknown> | null;
  };
  debuggerTargets: unknown[] | null;
  storage: Record<string, unknown>;
  operations: OperationEntry[];
  eventLog: EventLogEntry[];
}

/**
 * Storage keys that are safe to include verbatim in a support bundle.
 *
 * Anything sensitive (session tokens, pair JWTs, auth profile secrets)
 * must stay out of this list.
 */
const NON_SECRET_STORAGE_KEYS: readonly string[] = [
  "vellum.clientId",
  "vellum.selectedAssistant",
  "vellum.gatewayUrl",
  "vellum.userMode",
  "vellum.environment",
  "vellum.connectedOrganizationId",
  "autoConnect",
];

const MAX_OPERATIONS_IN_BUNDLE = 50;
const MAX_EVENT_LOG_IN_BUNDLE = 100;

/**
 * Assemble a sanitized snapshot of extension state for support to inspect.
 *
 * No secret material is included — session tokens, pair JWTs, and any
 * auth profile material are deliberately omitted. The caller supplies
 * the SSE connection state because that lives as a `let` binding in the
 * worker and is not exposed across module boundaries.
 */
export async function collectDiagnosticBundle(
  inputs: BundleCollectionInputs,
): Promise<DiagnosticBundle> {
  const [
    clientId,
    session,
    selectedAssistant,
    storage,
    debuggerTargets,
  ] = await Promise.all([
    getClientId(),
    safeReadSession(),
    safeReadSelectedAssistant(),
    readNonSecretStorage(),
    listDebuggerTargets(),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    extension: {
      version: chrome.runtime.getManifest().version,
      environment: inputs.env.environment,
      apiBaseUrl: inputs.env.apiBaseUrl,
      userAgent:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    },
    mode: inputs.mode,
    assistant: selectedAssistant
      ? { id: selectedAssistant.id, name: selectedAssistant.name }
      : null,
    organizationId:
      typeof storage["vellum.connectedOrganizationId"] === "string"
        ? (storage["vellum.connectedOrganizationId"] as string)
        : null,
    clientId,
    email: session?.email ?? null,
    sse: {
      state: inputs.sseState,
      detail: inputs.sseDetail ?? null,
    },
    debuggerTargets,
    storage,
    operations: getOperations().slice(-MAX_OPERATIONS_IN_BUNDLE),
    eventLog: getEventLog().slice(-MAX_EVENT_LOG_IN_BUNDLE),
  };
}

export interface SubmitOptions {
  /** Replace the resolved upload URL — primarily a test seam. */
  uploadUrl?: string;
  /** Replace the global `fetch` — primarily a test seam. */
  fetchImpl?: typeof fetch;
}

/**
 * POST the form + (optional) gzipped diagnostic bundle to the platform.
 *
 * Throws on non-2xx so the popup can render a meaningful error. On
 * success the response body is ignored.
 */
export async function submitFeedback(
  form: FeedbackFormData,
  bundle: DiagnosticBundle | null,
  env: EnvironmentContext,
  opts: SubmitOptions = {},
): Promise<void> {
  const uploadUrl = opts.uploadUrl ?? `${env.apiBaseUrl}/v1/upload/feedback/`;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const session = await safeReadSession();
  const clientId = await getClientId();

  const formData = new FormData();
  formData.set("message", form.message);
  formData.set("classification", form.classification);
  formData.set("email", form.email);
  formData.set("device_id", clientId);
  formData.set("client_version", chrome.runtime.getManifest().version);

  const selectedAssistant = await safeReadSelectedAssistant();
  if (selectedAssistant?.id) {
    formData.set("assistant_id", selectedAssistant.id);
  }

  if (bundle) {
    const gzipped = await gzipJson(bundle);
    formData.set(
      "logs_file",
      new File([gzipped], "vellum-extension-diagnostics.json.gz", {
        type: "application/gzip",
      }),
    );
  }

  const headers: Record<string, string> = {};
  if (session?.sessionToken) {
    headers["X-Session-Token"] = session.sessionToken;
  }
  const storage = await readNonSecretStorage();
  const orgId = storage["vellum.connectedOrganizationId"];
  if (typeof orgId === "string" && orgId.length > 0) {
    headers["Vellum-Organization-Id"] = orgId;
  }

  const resp = await fetchImpl(uploadUrl, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!resp.ok) {
    const body = await safeReadBody(resp);
    throw new Error(
      `Feedback upload failed: HTTP ${resp.status}${body ? ` — ${body}` : ""}`,
    );
  }
}

/**
 * Gzip a JSON-serializable value into a `Blob` via `CompressionStream`.
 *
 * `CompressionStream('gzip')` is available in MV3 service workers since
 * Chrome 80; the extension manifest pins a `minimum_chrome_version` of
 * 120 so we can rely on it unconditionally.
 */
export async function gzipJson(value: unknown): Promise<Blob> {
  const json = JSON.stringify(value);
  const input = new Blob([json], { type: "application/json" });
  const compressed = input
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(compressed).blob();
}

async function safeReadSession(): Promise<CloudSession | null> {
  try {
    return await getStoredSession();
  } catch {
    return null;
  }
}

async function safeReadSelectedAssistant(): Promise<SelectedAssistant | null> {
  try {
    return await getSelectedAssistant();
  } catch {
    return null;
  }
}

async function readNonSecretStorage(): Promise<Record<string, unknown>> {
  try {
    const stored = await chrome.storage.local.get(
      NON_SECRET_STORAGE_KEYS as unknown as string[],
    );
    const result: Record<string, unknown> = {};
    for (const key of NON_SECRET_STORAGE_KEYS) {
      if (key in stored) result[key] = stored[key];
    }
    return result;
  } catch {
    return {};
  }
}

async function listDebuggerTargets(): Promise<unknown[] | null> {
  try {
    if (typeof chrome === "undefined" || !chrome.debugger?.getTargets) {
      return null;
    }
    return await new Promise<unknown[]>((resolve) => {
      chrome.debugger.getTargets((t) => resolve(t ?? []));
    });
  } catch {
    return null;
  }
}

async function safeReadBody(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > 512 ? text.slice(0, 512) + "…[truncated]" : text;
  } catch {
    return "";
  }
}
