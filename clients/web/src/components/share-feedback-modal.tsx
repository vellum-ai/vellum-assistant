import { Capacitor } from "@capacitor/core";
import { useMutation } from "@tanstack/react-query";
import {
  Bug,
  Download,
  Info,
  Lightbulb,
  Loader2,
  type LucideIcon,
  Mail,
  MessageCircle,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { ChatDebugEventsApi } from "@/domains/chat/api/debug-api";
import type { ChatDebugApi } from "@/domains/chat/utils/debug-api";
import { feedbackCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import type {
  ClassificationEnum,
  ClientEnum,
} from "@/generated/api/types.gen";
import { logsExportPost } from "@/generated/daemon/sdk.gen";
import type { LogsExportPostData } from "@/generated/daemon/types.gen";
import { buildDiagnosticsSnapshot } from "@/lib/diagnostics";
import { buildDebugFlagSnapshot } from "@/lib/feature-flags/debug-flag-snapshot";
import { isElectron } from "@/runtime/is-electron";
import { useAuthStore } from "@/stores/auth-store";
import { VELLUM_COMMUNITY_URL } from "@/utils/external-urls";
import { Button } from "@vellumai/design-library/components/button";
import {
  Dropdown,
  type DropdownOption,
} from "@vellumai/design-library/components/dropdown";
import { Input, Textarea } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Tooltip } from "@vellumai/design-library/components/tooltip";
import type { FeedbackReason } from "@/components/share-feedback-types";

type TimeRange = "past_hour" | "past_24_hours" | "all_time";

interface ReasonOption {
  value: FeedbackReason;
  label: string;
  icon: LucideIcon;
  includesLogsByDefault: boolean;
}

const REASON_OPTIONS: ReasonOption[] = [
  {
    value: "bug_report",
    label: "Bug Report",
    icon: Bug,
    includesLogsByDefault: true,
  },
  {
    value: "feature_request",
    label: "Feature Request",
    icon: Lightbulb,
    includesLogsByDefault: false,
  },
  {
    value: "other",
    label: "Other",
    icon: MessageCircle,
    includesLogsByDefault: false,
  },
];

const TIME_RANGES: {
  value: TimeRange;
  label: string;
  cutoffMs: number | null;
}[] = [
  { value: "past_hour", label: "Past hour", cutoffMs: 60 * 60 * 1000 },
  {
    value: "past_24_hours",
    label: "Past 24 hours",
    cutoffMs: 24 * 60 * 60 * 1000,
  },
  { value: "all_time", label: "All time", cutoffMs: null },
];

const TIME_RANGE_OPTIONS: DropdownOption<TimeRange>[] = TIME_RANGES.map(
  (r) => ({
    value: r.value,
    label: r.label,
  }),
);

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const ALLOWED_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "mp4",
  "mov",
  "webm",
]);
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Decompressed size budget for the diagnostics archive.
 *
 * The platform opens `logs_file` with `tarfile.open(..., mode="r|")` and drops
 * the diagnostics when the *decompressed* archive exceeds its ceiling. The
 * feedback report itself still lands, so an oversized bundle fails silently
 * and costs exactly the evidence the report was filed to carry.
 *
 * The ceiling is enforced server-side and is not expressed anywhere in this
 * repo, so this budget sits well under the documented 50 MiB rather than at
 * it. Under-filling costs a slice of log history; over-filling costs the whole
 * bundle.
 */
export const MAX_BUNDLE_DECOMPRESSED_BYTES = 40 * 1024 * 1024;

/**
 * Per-member ceiling for the desktop main-process log.
 *
 * The desktop shells rotate `vellum.log` at 10 MB
 * (`clients/macos/src/main/logger.ts`), so a healthy log passes through whole.
 * The ceiling bounds the pathological case without letting one member consume
 * the budget the other diagnostics need.
 */
export const MAX_MAIN_LOG_BYTES = 12 * 1024 * 1024;

/**
 * Per-member ceiling for caller-supplied log files such as a Doctor session
 * transcript. Generous for a session transcript while leaving the rest of the
 * budget to the members offered after it.
 */
export const MAX_EXTRA_LOG_BYTES = 4 * 1024 * 1024;

const TAR_BLOCK_SIZE = 512;

/** Two zero blocks terminate a tar archive. */
const TAR_TRAILER_BYTES = TAR_BLOCK_SIZE * 2;

/** Budget held back so the manifest always fits. */
const BUNDLE_MANIFEST_RESERVE_BYTES = 8 * 1024;

/** Upper bound on the marker prefixed to a truncated member. */
const TRUNCATION_MARKER_MAX_BYTES = 256;

/** Bytes a member occupies: one header block plus its payload padded to a block. */
function tarEntrySize(byteLength: number): number {
  return (
    TAR_BLOCK_SIZE + Math.ceil(byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
  );
}

type BundleEntryStatus = "included" | "truncated" | "omitted";

interface BundleEntryReport {
  filename: string;
  status: BundleEntryStatus;
  original_bytes: number;
  included_bytes: number;
}

const CLASSIFICATION_MAP: Record<FeedbackReason, ClassificationEnum> = {
  bug_report: "bug_report",
  feature_request: "feature_request",
  other: "other",
};

/**
 * Which client this feedback is being sent from.
 *
 * Typed as the API's own `ClientEnum` rather than a restated union, so a value
 * the platform stops accepting is a compile error here instead of a rejected
 * submission at runtime — which is exactly how `android` got here: it was
 * removed from the enum server-side, and nothing on this side noticed.
 *
 * Android reports as `web` deliberately. No native Capacitor Android shell
 * ships (see `runtime/push-registration.ts`), so an Android device reaching
 * this is in a browser and *is* a web client. This field is triage metadata,
 * and failing the whole submission over it would cost the report itself.
 */
function getFeedbackClient(): ClientEnum {
  if (isElectron()) {
    return "electron";
  }
  return Capacitor.getPlatform() === "ios" ? "ios" : "web";
}

type FeedbackDiagnosticsProvider = () => Record<string, unknown> | null;

interface ExtraLogFile {
  filename: string;
  contents: string;
}

interface LogExportWindow {
  startTime: number | null;
  endTime: number;
}

function isAllowedFile(file: File): boolean {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return false;
  }
  if (file.type && ALLOWED_MIME_TYPES.has(file.type)) {
    return true;
  }
  if (!file.type) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    return ext ? ALLOWED_EXTENSIONS.has(ext) : false;
  }
  return false;
}

function buildTarEntry(filename: string, data: Uint8Array): Uint8Array {
  const blockSize = TAR_BLOCK_SIZE;
  const dataBlocks = Math.ceil(data.length / blockSize);
  const buffer = new Uint8Array(blockSize + dataBlocks * blockSize);
  const encoder = new TextEncoder();

  const writeAscii = (text: string, offset: number, length: number) => {
    const bytes = encoder.encode(text);
    buffer.set(bytes.slice(0, length), offset);
  };
  const writeOctal = (num: number, offset: number, length: number) => {
    const text = num.toString(8).padStart(length - 1, "0");
    writeAscii(text + "\0", offset, length);
  };

  writeAscii(filename, 0, 100);
  writeOctal(0o644, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(data.length, 124, 12);
  writeOctal(Math.floor(Date.now() / 1000), 136, 12);
  for (let i = 148; i < 156; i++) {
    buffer[i] = 0x20;
  }
  buffer[156] = 0x30;
  writeAscii("ustar\0", 257, 6);
  writeAscii("00", 263, 2);

  let checksum = 0;
  for (let i = 0; i < blockSize; i++) {
    checksum += buffer[i]!;
  }
  writeOctal(checksum, 148, 7);
  buffer[155] = 0x20;

  buffer.set(data, blockSize);
  return buffer;
}

/**
 * Tail of `bytes` that fits `maxPayloadBytes`, prefixed with a marker naming
 * what was dropped. Log files append chronologically, so the tail is the part
 * worth keeping.
 *
 * Returns `null` when the allowance leaves no room for content.
 */
function buildTruncatedTail(
  bytes: Uint8Array,
  maxPayloadBytes: number,
): Uint8Array | null {
  const keepBytes = maxPayloadBytes - TRUNCATION_MARKER_MAX_BYTES;
  if (keepBytes <= 0) {
    return null;
  }
  const tail = bytes.subarray(bytes.length - keepBytes);

  // Start on a line boundary. A newline byte never appears inside a multi-byte
  // UTF-8 sequence, so cutting just past one always lands on a code point
  // boundary. Without a newline, skip continuation bytes to get there.
  let start = tail.indexOf(0x0a);
  if (start >= 0) {
    start += 1;
  } else {
    start = 0;
    while (start < tail.length && (tail[start]! & 0xc0) === 0x80) {
      start += 1;
    }
  }
  const aligned = tail.subarray(start);

  const marker = new TextEncoder().encode(
    `[vellum] Truncated to fit the diagnostics upload budget. Kept the most recent ${aligned.length} of ${bytes.length} bytes.\n`,
  );
  const payload = new Uint8Array(marker.length + aligned.length);
  payload.set(marker, 0);
  payload.set(aligned, marker.length);
  return payload;
}

/**
 * Accumulates tar members under a fixed decompressed-size budget.
 *
 * Members are offered in priority order: the small structured payloads that
 * every report needs go first, the bulk log members last. A member that no
 * longer fits is truncated when its content is a chronological log, and
 * dropped otherwise (JSON and nested archives are not meaningfully
 * truncatable). Either way the outcome is recorded so a reader can tell a
 * missing member from an empty one.
 *
 * Every truncatable member carries its own ceiling, so no single log can
 * consume the budget the members behind it need.
 */
function createBundleWriter(maxBytes: number) {
  const parts: Uint8Array[] = [];
  const entries: BundleEntryReport[] = [];
  const encoder = new TextEncoder();
  let used = TAR_TRAILER_BYTES + BUNDLE_MANIFEST_RESERVE_BYTES;

  const remaining = () => maxBytes - used;

  const record = (
    filename: string,
    status: BundleEntryStatus,
    originalBytes: number,
    includedBytes: number,
  ) => {
    entries.push({
      filename,
      status,
      original_bytes: originalBytes,
      included_bytes: includedBytes,
    });
  };

  const push = (filename: string, data: Uint8Array) => {
    parts.push(buildTarEntry(filename, data));
    used += tarEntrySize(data.length);
  };

  return {
    /** Add an opaque member whole, or drop it when it does not fit. */
    addBytes(filename: string, data: Uint8Array) {
      if (tarEntrySize(data.length) > remaining()) {
        record(filename, "omitted", data.length, 0);
        return;
      }
      push(filename, data);
      record(filename, "included", data.length, data.length);
    },

    /**
     * Add a chronological text member, tail-truncating it to fit the smaller
     * of `maxMemberBytes` and the remaining budget.
     *
     * `maxMemberBytes` is required: without a ceiling an oversized member
     * truncates to the entire remaining budget and starves every member
     * offered after it.
     */
    addText(filename: string, text: string, maxMemberBytes: number) {
      const data = encoder.encode(text);
      const allowance = Math.min(
        maxMemberBytes,
        remaining() - TAR_BLOCK_SIZE, // header
      );
      if (data.length <= allowance) {
        push(filename, data);
        record(filename, "included", data.length, data.length);
        return;
      }
      const truncated = buildTruncatedTail(
        data,
        // Payload has to land on a block boundary to stay inside the budget.
        Math.floor(allowance / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE,
      );
      if (!truncated) {
        record(filename, "omitted", data.length, 0);
        return;
      }
      push(filename, truncated);
      record(filename, "truncated", data.length, truncated.length);
    },

    /** Append the manifest plus the trailer and return the assembled tar. */
    finish(): Uint8Array<ArrayBuffer> {
      const manifest = {
        max_decompressed_bytes: maxBytes,
        entries,
      };
      let manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
      if (tarEntrySize(manifestBytes.length) > BUNDLE_MANIFEST_RESERVE_BYTES) {
        manifestBytes = encoder.encode(
          JSON.stringify({ ...manifest, entries: [] }, null, 2),
        );
      }
      parts.push(buildTarEntry("web-bundle-budget.json", manifestBytes));
      parts.push(new Uint8Array(TAR_TRAILER_BYTES));

      const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
      const buffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const part of parts) {
        buffer.set(part, offset);
        offset += part.length;
      }
      return buffer;
    },
  };
}

async function fetchPlatformLogs(
  assistantId: string,
  opts: {
    window: LogExportWindow;
    activeConversationId?: string | null;
  },
): Promise<Uint8Array | null> {
  try {
    const body: LogsExportPostData["body"] = {};
    if (opts.window.startTime != null) {
      body.startTime = opts.window.startTime;
      body.endTime = opts.window.endTime;
    }
    // Forward the active conversation key as `conversationId` so the backend
    // can scope the export to messages / LLM request logs / usage events /
    // tool invocations for that conversation. The backend accepts any
    // non-empty string here — conversation keys take many shapes
    // (e.g. `slack-thread:C123:1700000000.000000`), so we deliberately do
    // NOT gate on UUID format.
    if (opts.activeConversationId) {
      body.conversationId = opts.activeConversationId;
    }
    const { data, error } = await logsExportPost({
      path: { assistant_id: assistantId },
      body,
      parseAs: "blob",
      throwOnError: false,
    });
    if (error || !(data instanceof Blob)) {
      return null;
    }
    const buf = await data.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * Native shell identity, or `null` off a Capacitor shell.
 *
 * Pins which store/TestFlight build hosted this report. It also settles native
 * shell versus home-screen PWA, which the user agent cannot: `WKWebView` drops
 * the `Version/` and `Safari/` tokens in both cases, so the two are
 * indistinguishable from the UA string alone.
 *
 * `@capacitor/app` is a plugin Proxy, so it is destructured inline per
 * `docs/CAPACITOR.md` § "Capacitor plugins must be destructured inline".
 */
async function collectNativeAppInfo(): Promise<Record<string, unknown> | null> {
  if (!Capacitor.isNativePlatform()) {
    return null;
  }
  try {
    const { App } = await import("@capacitor/app");
    const { id, name, version, build } = await App.getInfo();
    return { id, name, version, build };
  } catch {
    // Diagnostics are best-effort and must never block a support submission.
    return null;
  }
}

export async function buildClientLogsFile(
  timeRange: TimeRange,
  assistantId: string | null,
  activeConversationId: string | null,
  options: {
    diagnosticsProvider?: FeedbackDiagnosticsProvider;
    doctorSessionId?: string | null;
    extraLogFiles?: readonly ExtraLogFile[];
  } = {},
): Promise<File | null> {
  if (typeof CompressionStream === "undefined") {
    return null;
  }
  const { diagnosticsProvider, doctorSessionId, extraLogFiles = [] } = options;
  const now = new Date();
  const range = TIME_RANGES.find((t) => t.value === timeRange);
  const endTime = now.getTime();
  const startTime = range?.cutoffMs != null ? endTime - range.cutoffMs : null;
  const cutoff = startTime != null ? new Date(startTime).toISOString() : null;
  let currentChatState: Record<string, unknown> | null = null;
  try {
    currentChatState = diagnosticsProvider?.() ?? null;
  } catch {
    currentChatState = null;
  }
  const chatDiagnostics = buildDiagnosticsSnapshot(currentChatState);
  const payload = {
    collected_at: now.toISOString(),
    time_range: timeRange,
    cutoff,
    log_window: {
      start_time_ms: startTime,
      end_time_ms: endTime,
    },
    assistant_id: assistantId,
    active_conversation_id: activeConversationId,
    doctor_session_id: doctorSessionId ?? null,
    // Which web bundle produced this report. The archive already carries the
    // assistant's version, but the two ship on entirely separate cadences: the
    // native shells load this bundle over the network at runtime, so a report
    // can pair an arbitrarily new assistant with an arbitrarily old (or cached)
    // client, and without this there is no way to tell which client fix was
    // actually present.
    client_version: import.meta.env.VITE_APP_VERSION ?? null,
    native_app: await collectNativeAppInfo(),
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    language: typeof navigator !== "undefined" ? navigator.language : "",
    platform: typeof navigator !== "undefined" ? navigator.platform : "",
    url: typeof window !== "undefined" ? window.location.href : "",
    viewport:
      typeof window !== "undefined"
        ? { width: window.innerWidth, height: window.innerHeight }
        : null,
    screen:
      typeof screen !== "undefined"
        ? { width: screen.width, height: screen.height }
        : null,
    connection:
      typeof navigator !== "undefined" && "connection" in navigator
        ? {
            effectiveType: (navigator.connection as { effectiveType?: string })
              .effectiveType,
            downlink: (navigator.connection as { downlink?: number }).downlink,
            rtt: (navigator.connection as { rtt?: number }).rtt,
          }
        : null,
    deviceMemory:
      typeof navigator !== "undefined" && "deviceMemory" in navigator
        ? (navigator as { deviceMemory?: number }).deviceMemory
        : null,
    hardwareConcurrency:
      typeof navigator !== "undefined" ? navigator.hardwareConcurrency : null,
  };
  const encoder = new TextEncoder();
  const contextBytes = encoder.encode(JSON.stringify(payload, null, 2));
  const diagnosticsBytes = encoder.encode(
    JSON.stringify(chatDiagnostics, null, 2),
  );
  const bundle = createBundleWriter(MAX_BUNDLE_DECOMPRESSED_BYTES);
  bundle.addBytes("web-client-context.json", contextBytes);
  bundle.addBytes("web-chat-diagnostics.json", diagnosticsBytes);

  // Capture client debug-flag state so flag values are unambiguous during
  // analysis. The flags are localStorage-only overrides with no server
  // targeting, so they can't be reconstructed after the fact — a report has
  // to carry them or the resolved value is lost.
  const debugFlagBytes = new TextEncoder().encode(
    JSON.stringify(buildDebugFlagSnapshot(), null, 2),
  );
  bundle.addBytes("web-debug-flags.json", debugFlagBytes);

  // Capture the live chat debug API state for indicator-stuck and
  // stuck-prompt reports. This is a separate file so support can diff it
  // against the main diagnostics snapshot without cross-contamination.
  try {
    const debugApi =
      typeof window !== "undefined"
        ? (window as unknown as { _vellumDebug?: { chat?: ChatDebugApi } })
            ._vellumDebug?.chat
        : null;
    if (debugApi) {
      const triagePayload = {
        clientMessages: debugApi.getClientMessages?.() ?? null,
        transcriptItems: debugApi.getTranscriptItems?.() ?? null,
        // Ephemeral interaction prompts (secret / confirmation /
        // contact-request / question) render as transcript trailer rows
        // outside any message's `contentBlocks`, so they're invisible in
        // `clientMessages`/`transcriptItems` payloads above. Capture the
        // interaction-store snapshot to triage stuck-prompt reports. Carries
        // prompt metadata only — never the entered secret value.
        pendingInteractions: debugApi.listPendingInteractions?.() ?? null,
        thinkingIndicator: debugApi.thinkingIndicator?.() ?? null,
        streamingRing: debugApi.streamingRing?.() ?? null,
        reconciliationDiagnostics:
          debugApi.getReconciliationDiagnostics?.() ?? null,
      };
      const triageBytes = new TextEncoder().encode(
        JSON.stringify(triagePayload, null, 2),
      );
      bundle.addBytes("web-chat-debug-api-triage.json", triageBytes);
    }
  } catch {
    // Debug API is best-effort; if it's missing or throws, don't block the
    // feedback submission. This can happen during SSR, in tests, or if the
    // chat page hasn't mounted the API yet.
  }

  // SSE clients/events + focus/visibility, read through the same live debug
  // API. Per-client traffic ages (no bytes for minutes but never errored)
  // plus a `hasFocus:false` + `visibilityState:"visible"` capture are the
  // fingerprint of the "stale after refocus" report — `visibilitychange`
  // only fires on tab-switch / minimize / full occlusion, not when the
  // browser window merely loses focus to another app.
  try {
    const eventsApi =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              _vellumDebug?: { events?: ChatDebugEventsApi };
            }
          )._vellumDebug?.events
        : null;
    if (eventsApi) {
      const triagePayload = {
        focus:
          typeof document !== "undefined"
            ? {
                hasFocus:
                  typeof document.hasFocus === "function"
                    ? document.hasFocus()
                    : null,
                visibilityState: document.visibilityState,
              }
            : null,
        // `AbortSignal` isn't JSON-serializable, so project it to an
        // `aborted` flag and keep the rest of each client verbatim.
        clients: eventsApi.getClients().map(({ abortSignal, ...rest }) => ({
          ...rest,
          aborted: abortSignal.aborted,
        })),
        events: eventsApi.getEvents(),
      };
      const triageBytes = new TextEncoder().encode(
        JSON.stringify(triagePayload, null, 2),
      );
      bundle.addBytes("web-sse-liveness-triage.json", triageBytes);
    }
  } catch {
    // Debug API is best-effort; if it's missing or throws, don't block the
    // feedback submission. This can happen during SSR, in tests, or if the
    // chat page hasn't mounted the API yet.
  }

  for (const file of extraLogFiles) {
    const contents = file.contents.trim();
    if (contents) {
      bundle.addText(file.filename, contents, MAX_EXTRA_LOG_BYTES);
    }
  }

  if (isElectron() && window.vellum?.feedback) {
    try {
      const electronDiagnostics = await window.vellum.feedback.diagnostics();
      const diagBytes = new TextEncoder().encode(
        JSON.stringify(electronDiagnostics, null, 2),
      );
      bundle.addBytes("electron-diagnostics.json", diagBytes);
    } catch {
      /* best-effort */
    }

    try {
      const redactedLogs = await window.vellum.feedback.logs();
      if (redactedLogs) {
        bundle.addText(
          "electron-main-logs.txt",
          redactedLogs,
          MAX_MAIN_LOG_BYTES,
        );
      }
    } catch {
      /* best-effort */
    }
  }

  if (assistantId) {
    const platformLogsData = await fetchPlatformLogs(assistantId, {
      window: { startTime, endTime },
      activeConversationId,
    });
    if (platformLogsData) {
      bundle.addBytes("platform-logs.tar.gz", platformLogsData);
    }
  }

  const tarBuffer = bundle.finish();
  const tarBlob = new Blob([tarBuffer]);

  const compressed = await new Response(
    tarBlob.stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
  return new File([compressed], `web-client-logs-${now.getTime()}.tar.gz`, {
    type: "application/gzip",
  });
}

export interface ShareFeedbackModalProps {
  open: boolean;
  onClose: () => void;
  initialReason?: FeedbackReason;
  initialMessage?: string;
  onSubmitted?: () => void;
  assistantId?: string | null;
  assistantVersion?: string | null;
  activeConversationId?: string | null;
  doctorSessionId?: string | null;
  doctorSessionLog?: string | null;
  getDiagnosticsSnapshot?: FeedbackDiagnosticsProvider;
}

export function ShareFeedbackModal({
  open,
  onClose,
  initialReason,
  initialMessage,
  onSubmitted,
  assistantId,
  assistantVersion,
  activeConversationId,
  doctorSessionId,
  doctorSessionLog,
  getDiagnosticsSnapshot,
}: ShareFeedbackModalProps) {
  const authUser = useAuthStore.use.user();
  const authEmail = authUser?.email;
  const isStaff = authUser?.isStaff ?? false;
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const [selectedReason, setSelectedReason] = useState<FeedbackReason>(
    initialReason ?? "bug_report",
  );
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [includeLogs, setIncludeLogs] = useState<boolean>(
    REASON_OPTIONS.find((r) => r.value === (initialReason ?? "bug_report"))
      ?.includesLogsByDefault ?? true,
  );
  const [hasManuallyToggledLogs, setHasManuallyToggledLogs] = useState(false);
  const [logTimeRange, setLogTimeRange] = useState<TimeRange>("past_hour");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [includeConversation, setIncludeConversation] = useState(false);
  // Admin-only: build the diagnostics archive locally and download it
  // instead of submitting feedback (which notifies Slack).
  const [adminDownloadMode, setAdminDownloadMode] = useState(false);

  const mutation = useMutation(feedbackCreateMutation());
  const [isBuildingLogs, setIsBuildingLogs] = useState(false);
  const isSubmitting = mutation.isPending || isBuildingLogs;

  const shouldShowEmail = !authEmail;
  const canSend = useMemo(
    () => message.trim().length > 0 && email.trim().length > 0,
    [message, email],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const reason = initialReason ?? "bug_report";
    setSelectedReason(reason);
    setMessage(initialMessage ?? "");
    setEmail(authEmail ?? "");
    setIncludeLogs(
      REASON_OPTIONS.find((r) => r.value === reason)?.includesLogsByDefault ??
        true,
    );
    setHasManuallyToggledLogs(false);
    setLogTimeRange("past_hour");
    setAttachments([]);
    setIncludeConversation(false);
    setAdminDownloadMode(false);
    setSubmitError(null);
    setIsBuildingLogs(false);
    mutation.reset();
    const t = setTimeout(() => {
      if (!authEmail) {
        emailRef.current?.focus();
      } else {
        messageRef.current?.focus();
      }
    }, 50);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const handleSelectReason = (reason: FeedbackReason) => {
    setSelectedReason(reason);
    if (!hasManuallyToggledLogs) {
      setIncludeLogs(
        REASON_OPTIONS.find((r) => r.value === reason)?.includesLogsByDefault ??
          false,
      );
    }
  };

  const handleToggleLogs = () => {
    setIncludeLogs((v) => !v);
    setHasManuallyToggledLogs(true);
  };

  const doctorLogFiles: ExtraLogFile[] = doctorSessionLog?.trim()
    ? [{ filename: "doctor-session.txt", contents: doctorSessionLog }]
    : [];

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !isSubmitting) {
        e.preventDefault();
        onClose();
      }
    },
    [onClose, isSubmitting],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current && !isSubmitting) {
        onClose();
      }
    },
    [onClose, isSubmitting],
  );

  const addFiles = useCallback((files: File[]) => {
    setAttachments((current) => {
      const remaining = MAX_ATTACHMENTS - current.length;
      if (remaining <= 0) {
        return current;
      }
      const existingKeys = new Set(current.map((f) => `${f.name}:${f.size}`));
      const accepted: File[] = [];
      for (const file of files) {
        if (accepted.length >= remaining) {
          break;
        }
        if (!isAllowedFile(file)) {
          continue;
        }
        const key = `${file.name}:${file.size}`;
        if (existingKeys.has(key)) {
          continue;
        }
        existingKeys.add(key);
        accepted.push(file);
      }
      return accepted.length > 0 ? [...current, ...accepted] : current;
    });
  }, []);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(Array.from(e.target.files));
    }
    e.target.value = "";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!canSend || isSubmitting) {
      return;
    }
    setSubmitError(null);
    setIsBuildingLogs(true);
    try {
      const logsFile =
        includeLogs && selectedReason !== "feature_request"
          ? await buildClientLogsFile(
              logTimeRange,
              assistantId ?? null,
              isElectron()
                ? includeConversation
                  ? (activeConversationId ?? null)
                  : null
                : (activeConversationId ?? null),
              {
                diagnosticsProvider: getDiagnosticsSnapshot,
                doctorSessionId,
                extraLogFiles: doctorLogFiles,
              },
            )
          : null;
      await mutation.mutateAsync({
        headers: { "Content-Type": null },
        body: {
          message: message.trim(),
          classification: CLASSIFICATION_MAP[selectedReason],
          email: email.trim(),
          client: getFeedbackClient(),
          client_version: import.meta.env.VITE_APP_VERSION ?? undefined,
          ...(assistantId ? { assistant_id: assistantId } : {}),
          ...(assistantVersion ? { assistant_version: assistantVersion } : {}),
          ...(doctorSessionId ? { doctor_session_id: doctorSessionId } : {}),
          ...(logsFile ? { logs_file: logsFile } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
        bodySerializer: (body) => {
          const form = new FormData();
          for (const [key, value] of Object.entries(
            body as Record<string, unknown>,
          )) {
            if (value == null) {
              continue;
            }
            if (key === "attachments" && Array.isArray(value)) {
              for (const file of value) {
                form.append("attachments", file as Blob);
              }
              continue;
            }
            if (value instanceof Blob) {
              form.append(key, value);
            } else {
              form.append(key, String(value));
            }
          }
          return form;
        },
      });
      onSubmitted?.();
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Failed to submit feedback. Please try again.",
      );
    } finally {
      setIsBuildingLogs(false);
    }
  };

  // Admin-only path: build the diagnostics archive client-side and hand it
  // to the browser as a download. No feedback submission and no Slack
  // notification.
  const handleDownload = async () => {
    if (isSubmitting) {
      return;
    }
    setSubmitError(null);
    setIsBuildingLogs(true);
    try {
      const logsFile = await buildClientLogsFile(
        logTimeRange,
        assistantId ?? null,
        isElectron()
          ? includeConversation
            ? (activeConversationId ?? null)
            : null
          : (activeConversationId ?? null),
        {
          diagnosticsProvider: getDiagnosticsSnapshot,
          doctorSessionId,
          extraLogFiles: doctorLogFiles,
        },
      );
      if (!logsFile) {
        setSubmitError("Diagnostics export isn't supported in this browser.");
        return;
      }
      const url = URL.createObjectURL(logsFile);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = logsFile.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Failed to build diagnostics. Please try again.",
      );
    } finally {
      setIsBuildingLogs(false);
    }
  };

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div
        className="mx-4 flex w-full max-w-lg flex-col rounded-xl border p-6 shadow-xl"
        style={{
          backgroundColor: "var(--surface-lift)",
          borderColor: "var(--border-base)",
          maxHeight: "calc(100vh - 2rem)",
        }}
      >
        <div
          className="flex items-center justify-between border-b pb-4"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <h2
            id={titleId}
            className="!m-0 text-title-small text-[var(--content-default)]"
          >
            Share Feedback
          </h2>
          <Button
            variant="ghost"
            iconOnly={<X />}
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close"
            tintColor="var(--content-secondary)"
          />
        </div>

        <div
          className={`flex flex-col gap-3.5 overflow-y-auto pt-4 ${isSubmitting ? "pointer-events-none opacity-60" : ""}`}
        >
          {isStaff && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2.5">
              <label className="flex cursor-pointer items-center gap-3">
                <Toggle
                  checked={adminDownloadMode}
                  onChange={() => setAdminDownloadMode((v) => !v)}
                  aria-label="Download diagnostics directly"
                />
                <span className="text-body-medium-lighter text-[var(--content-default)]">
                  Download diagnostics directly
                </span>
              </label>
              <span className="text-body-small-default text-[var(--content-secondary)]">
                Admin only — builds the diagnostics archive locally and
                downloads it instead of submitting feedback or notifying Slack.
              </span>
            </div>
          )}

          {adminDownloadMode ? (
            <div className="flex items-center gap-3">
              <span className="text-body-medium-lighter text-[var(--content-default)]">
                Time range
              </span>
              <Dropdown
                options={TIME_RANGE_OPTIONS}
                value={logTimeRange}
                onChange={setLogTimeRange}
                aria-label="Diagnostics time range"
              />
            </div>
          ) : (
            <>
              {shouldShowEmail && (
                <Input
                  id={`${titleId}-email`}
                  ref={emailRef}
                  label="Email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  leftIcon={<Mail className="h-4 w-4" aria-hidden />}
                  fullWidth
                />
              )}

              <div className="flex flex-col gap-1.5">
                <span className="text-body-small-default text-[var(--content-secondary)]">
                  Category
                </span>
                <div className="flex gap-2">
                  {REASON_OPTIONS.map((option) => (
                    <ReasonChip
                      key={option.value}
                      option={option}
                      isSelected={selectedReason === option.value}
                      onSelect={() => handleSelectReason(option.value)}
                    />
                  ))}
                </div>
              </div>

              <hr className="border-[var(--border-subtle)]" />

              {selectedReason === "bug_report" && (
                <Notice tone="info">
                  Tip: Get faster support by posting in our{" "}
                  <a
                    href={VELLUM_COMMUNITY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-[var(--content-default)]"
                  >
                    Discord community
                  </a>
                </Notice>
              )}

              {selectedReason === "feature_request" && (
                <Notice tone="info">
                  Tip: Vote on features on our{" "}
                  <a
                    href="https://vellum.ai/roadmap"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-[var(--content-default)]"
                  >
                    public roadmap
                  </a>
                </Notice>
              )}

              <Textarea
                id={`${titleId}-message`}
                ref={messageRef}
                label={
                  selectedReason === "bug_report"
                    ? "What went wrong?"
                    : selectedReason === "feature_request"
                      ? "Describe your idea"
                      : "What's on your mind?"
                }
                rows={3}
                placeholder={
                  selectedReason === "bug_report"
                    ? "What did you expect to happen, and what happened instead?"
                    : selectedReason === "feature_request"
                      ? "What problem would this solve for you?"
                      : "Share your thoughts..."
                }
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                fullWidth
              />

              {selectedReason !== "feature_request" && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <label className="flex cursor-pointer items-center gap-2.5">
                      <Toggle
                        checked={includeLogs}
                        onChange={handleToggleLogs}
                        aria-label="Include browser diagnostics"
                      />
                      <span className="text-body-medium-lighter leading-6 text-[var(--content-default)]">
                        Include diagnostics
                      </span>
                    </label>
                    <Tooltip content="Diagnostics include browser context, assistant logs, and timestamps — never passwords or credentials.">
                      <button
                        type="button"
                        aria-label="About diagnostics"
                        className="inline-flex items-center justify-center text-[var(--content-tertiary)]"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                  {includeLogs && (
                    <Dropdown
                      options={TIME_RANGE_OPTIONS}
                      value={logTimeRange}
                      onChange={setLogTimeRange}
                      aria-label="Diagnostics time range"
                    />
                  )}
                </div>
              )}

              {isElectron() &&
                activeConversationId &&
                selectedReason !== "feature_request" && (
                  <label className="flex cursor-pointer items-center gap-2.5">
                    <Toggle
                      checked={includeConversation}
                      onChange={() => setIncludeConversation((v) => !v)}
                      aria-label="Include the most recent conversation"
                    />
                    <span className="text-body-medium-lighter leading-6 text-[var(--content-default)]">
                      Include the most recent conversation
                    </span>
                  </label>
                )}

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-body-small-default text-[var(--content-secondary)]">
                    Attachments
                    {attachments.length > 0 && (
                      <span className="text-[var(--content-tertiary)]">
                        {" · "}
                        {attachments.length}/{MAX_ATTACHMENTS}
                      </span>
                    )}
                  </span>
                  <Button
                    variant="outlined"
                    size="compact"
                    leftIcon={<Paperclip />}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={attachments.length >= MAX_ATTACHMENTS}
                  >
                    Add files
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
                    onChange={onFileInputChange}
                    className="hidden"
                  />
                </div>
                {attachments.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto">
                    {attachments.map((file, idx) => (
                      <AttachmentThumbnail
                        key={`${file.name}-${idx}`}
                        file={file}
                        onRemove={() => removeAttachment(idx)}
                      />
                    ))}
                  </div>
                )}
                {isDragging && (
                  <p className="text-body-small-default text-[var(--content-tertiary)]">
                    Drop files to attach…
                  </p>
                )}
              </div>
            </>
          )}

          {submitError && (
            <p className="text-body-medium-lighter text-[var(--system-negative-strong)]">
              {submitError}
            </p>
          )}
        </div>

        <div
          className="mt-4 flex items-center justify-end gap-2 border-t pt-4"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          {isSubmitting ? (
            <span className="inline-flex items-center gap-2 text-body-medium-lighter text-[var(--content-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {adminDownloadMode
                ? "Preparing diagnostics…"
                : "Sending feedback…"}
            </span>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              {adminDownloadMode ? (
                <Button
                  variant="primary"
                  leftIcon={<Download />}
                  onClick={handleDownload}
                >
                  Download diagnostics
                </Button>
              ) : (
                <Button
                  variant="primary"
                  leftIcon={<Send />}
                  onClick={handleSubmit}
                  disabled={!canSend}
                >
                  Submit
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ReasonChip({
  option,
  isSelected,
  onSelect,
}: {
  option: ReasonOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const Icon = option.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-left transition-colors"
      style={{
        borderColor: isSelected ? "var(--primary-base)" : "var(--border-base)",
        backgroundColor: isSelected
          ? "color-mix(in oklab, var(--primary-base) 10%, transparent)"
          : "transparent",
      }}
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0"
        style={{
          color: isSelected
            ? "var(--primary-base)"
            : "var(--content-secondary)",
        }}
      />
      <span
        className="text-body-small-default"
        style={{
          color: isSelected ? "var(--primary-base)" : "var(--content-default)",
        }}
      >
        {option.label}
      </span>
    </button>
  );
}

function AttachmentThumbnail({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const isImage = file.type.startsWith("image/");
  const previewUrl = useMemo(
    () => (isImage ? URL.createObjectURL(file) : null),
    [file, isImage],
  );

  useEffect(() => {
    if (!previewUrl) {
      return;
    }
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <div
      className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)]"
      title={file.name}
    >
      {isImage && previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <Paperclip className="h-5 w-5 text-[var(--content-secondary)]" />
      )}
      <Button
        variant="ghost"
        size="compact"
        iconOnly={<X />}
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-black/60 text-white hover:bg-black/70"
        tintColor="#fff"
      />
    </div>
  );
}
