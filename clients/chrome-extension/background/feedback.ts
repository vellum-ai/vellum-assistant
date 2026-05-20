/**
 * Share Feedback flow for the Chrome extension.
 *
 * Mirrors the macOS `LogReportFormView` / `LogExporter` contract so a
 * user (or support engineer) can ship a focused diagnostic bundle
 * back to the platform without leaving the popup. Submissions land at
 * `POST {apiBaseUrl}/v1/upload/feedback/` as `multipart/form-data` with
 * the same field shape the macOS app uses — `message`, `classification`,
 * `email`, `device_id`, `client_version`, optional `assistant_id`, and a
 * `logs_file` part containing a single-member `tar.gz` archive with the
 * diagnostic bundle JSON inside.
 *
 * The platform-side `sanitize_tar_gz` validator opens `logs_file` as
 * `tarfile.open(..., mode="r|")` and drops the upload on the floor when
 * it isn't a real tar — so we ship a real (one-file) tar.gz instead of a
 * plain gzipped JSON blob.
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
    const archive = await buildBundleTarGz(bundle);
    formData.set(
      "logs_file",
      new File([archive], "vellum-extension-diagnostics.tar.gz", {
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

/** Filename of the single member written into the support bundle archive. */
export const BUNDLE_TAR_MEMBER_NAME = "extension-diagnostics.json";

const TAR_BLOCK_SIZE = 512;

/**
 * Build a single-member `tar.gz` archive containing the JSON-serialized
 * *bundle* as `extension-diagnostics.json`.
 *
 * The platform-side `sanitize_tar_gz` validator opens uploads with
 * `tarfile.open(..., mode="r|")` and drops uploads that don't yield a
 * valid tar — we ship a real (one-file) ustar archive so the bundle
 * makes it through sanitization end-to-end.
 */
export async function buildBundleTarGz(value: unknown): Promise<Blob> {
  const json = JSON.stringify(value);
  const payload = new TextEncoder().encode(json);
  const mtime = Math.floor(Date.now() / 1000);
  const tar = buildSingleFileTar(BUNDLE_TAR_MEMBER_NAME, payload, mtime);
  const compressed = new Blob([new Uint8Array(tar)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(compressed).blob();
}

/**
 * Build an in-memory ustar archive containing a single regular-file
 * member with the given name, payload, and modification time. Two
 * trailing zero blocks are appended so standard tar readers recognise
 * the archive as terminated.
 */
function buildSingleFileTar(
  filename: string,
  content: Uint8Array,
  mtime: number,
): Uint8Array {
  const header = buildUstarHeader(filename, content.length, mtime);

  const contentBlocks =
    Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  const totalSize =
    TAR_BLOCK_SIZE + contentBlocks + TAR_BLOCK_SIZE * 2; // header + padded payload + 2 zero blocks
  const out = new Uint8Array(totalSize);
  out.set(header, 0);
  out.set(content, TAR_BLOCK_SIZE);
  // Padding between content and the two zero blocks is already zero by
  // virtue of Uint8Array initialization. The trailing two zero blocks are
  // likewise already zero — nothing else to write.
  return out;
}

/**
 * Build a 512-byte ustar header for a regular file. The checksum field
 * is filled in by summing the header bytes with the checksum field
 * itself treated as ASCII spaces (per POSIX), then writing the result
 * back as six octal digits followed by `\0 `.
 */
function buildUstarHeader(
  filename: string,
  size: number,
  mtime: number,
): Uint8Array {
  const enc = new TextEncoder();
  const header = new Uint8Array(TAR_BLOCK_SIZE);

  const nameBytes = enc.encode(filename);
  if (nameBytes.length > 100) {
    throw new Error(
      `tar member name exceeds the 100-byte ustar limit: ${filename}`,
    );
  }

  // Layout (byte offsets):
  //   0..99    name        | 100..107 mode    | 108..115 uid
  //   116..123 gid          | 124..135 size    | 136..147 mtime
  //   148..155 checksum     | 156      typeflag| 157..256 linkname
  //   257..262 magic        | 263..264 version | 265..296 uname
  //   297..328 gname        | 329..336 devmajor| 337..344 devminor
  //   345..499 prefix       | 500..511 pad
  header.set(nameBytes, 0);
  header.set(enc.encode(octalField(0o644, 8)), 100); // mode
  header.set(enc.encode(octalField(0, 8)), 108); // uid
  header.set(enc.encode(octalField(0, 8)), 116); // gid
  header.set(enc.encode(octalField(size, 12)), 124); // size
  header.set(enc.encode(octalField(mtime, 12)), 136); // mtime
  // Checksum placeholder — spaces — so the checksum sum picks up a known constant.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = 0x30; // typeflag = '0' (regular file)
  header.set(enc.encode("ustar\0"), 257); // magic
  header.set(enc.encode("00"), 263); // version

  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) sum += header[i]!;
  // POSIX: 6 octal digits, NUL, space.
  const checksum = sum.toString(8).padStart(6, "0");
  header.set(enc.encode(checksum), 148);
  header[154] = 0x00;
  header[155] = 0x20;

  return header;
}

/**
 * Encode *value* as a zero-padded octal string of *width* bytes total,
 * with a trailing NUL byte (ustar's canonical numeric encoding).
 */
function octalField(value: number, width: number): string {
  if (value < 0 || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`tar octal field requires a non-negative integer: ${value}`);
  }
  const digits = value.toString(8).padStart(width - 1, "0");
  if (digits.length >= width) {
    throw new Error(
      `tar octal field overflow: ${value} does not fit in ${width - 1} octal digits`,
    );
  }
  return `${digits}\0`;
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
