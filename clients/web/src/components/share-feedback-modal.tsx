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
  type CSSProperties,
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
import type { ClassificationEnum, ClientEnum } from "@/generated/api/types.gen";
import { logsExportPost } from "@/generated/daemon/sdk.gen";
import type { LogsExportPostData } from "@/generated/daemon/types.gen";
import { useBodyScrollLock } from "@/hooks/use-body-scroll-lock";
import { buildDiagnosticsSnapshot } from "@/lib/diagnostics";
import { buildDebugFlagSnapshot } from "@/lib/feature-flags/debug-flag-snapshot";
import { isElectron } from "@/runtime/is-electron";
import { saveFile } from "@/runtime/native-file";
import { Trans, useTranslation } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { VELLUM_COMMUNITY_URL } from "@/utils/external-urls";
import { Button } from "@vellumai/design-library/components/button";
import {
  Select,
  type SelectOption,
} from "@vellumai/design-library/components/select";
import { Input, Textarea } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Tooltip } from "@vellumai/design-library/components/tooltip";
import type { FeedbackReason } from "@/components/share-feedback-types";

const BACKDROP_CLASS =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/50";

const PANEL_CLASS =
  "mx-4 flex w-full max-w-lg flex-col rounded-xl border p-6 shadow-xl";

const PANEL_STYLE: CSSProperties = {
  backgroundColor: "var(--surface-lift)",
  borderColor: "var(--border-base)",
  maxHeight: "calc(100vh - 2rem)",
};

type TimeRange = "past_hour" | "past_24_hours" | "all_time";

interface ReasonOption {
  value: FeedbackReason;
  icon: LucideIcon;
  includesLogsByDefault: boolean;
}

const REASON_OPTIONS: ReasonOption[] = [
  {
    value: "bug_report",
    icon: Bug,
    includesLogsByDefault: true,
  },
  {
    value: "feature_request",
    icon: Lightbulb,
    includesLogsByDefault: false,
  },
  {
    value: "other",
    icon: MessageCircle,
    includesLogsByDefault: false,
  },
];

interface TimeRangeDef {
  value: TimeRange;
  cutoffMs: number | null;
}

const TIME_RANGES: TimeRangeDef[] = [
  { value: "past_hour", cutoffMs: 60 * 60 * 1000 },
  {
    value: "past_24_hours",
    cutoffMs: 24 * 60 * 60 * 1000,
  },
  { value: "all_time", cutoffMs: null },
];

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
 * submission at runtime.
 */
function getFeedbackClient(): ClientEnum {
  if (isElectron()) {
    return "electron";
  }
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") {
    return platform;
  }
  return "web";
}

function isFeedbackClientValidationError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "client" in error;
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

/** Strings at or past this length are candidates for base64 stripping. */
const BULK_BASE64_MIN_CHARS = 8192;

const DATA_URI_RE = /^data:([^;,]+);base64,/i;
const PURE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Marker (or transformed leaf) to emit in place of `value`, or `null` to
 * leave primitives as-is and descend into objects/arrays.
 */
type CaptureVisitor = (value: unknown) => { replacement: unknown } | null;

/**
 * Depth-first structural map over a diagnostics snapshot.
 *
 * The `path` set holds only the current recursion ancestry, so a true cycle
 * is replaced with `"[cyclic]"` while shared (sibling) references are
 * traversed in full. The capture leans on shared references by construction:
 * transcript items embed the same message objects `clientMessages` lists.
 * JSON.stringify duplicates shared references the same way.
 *
 * Every capture pass (base64 stripping, message deduplication) is a visitor
 * over this one walker, so traversal and cycle handling have a single home.
 */
function deepMapCapture(
  value: unknown,
  visit: CaptureVisitor,
  path = new WeakSet<object>(),
): unknown {
  const hit = visit(value);
  if (hit) {
    return hit.replacement;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (path.has(value)) {
    return "[cyclic]";
  }
  path.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => deepMapCapture(v, visit, path));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = deepMapCapture(v, visit, path);
    }
    out = obj;
  }
  path.delete(value);
  return out;
}

/**
 * Replace bulk binary payloads in a diagnostics snapshot with size markers.
 *
 * Message state carries image bytes in two shapes: `data:` URIs (derived
 * preview URLs) and long raw base64 fields (inline attachment data). Neither
 * is diagnostic signal, and a handful of photos otherwise dominates the
 * bundle the platform accepts. Matching is content-based, not field-name
 * based, so any future field that carries a data URI or a long pure-base64
 * string is stripped too. Prose is never touched: text with spaces or
 * punctuation fails the base64 test, and short strings (ids, hashes,
 * tokens) are below the length floor. The marker keeps the mime type and
 * length, which is the diagnostically useful part.
 */
export function stripBulkBase64(value: unknown): unknown {
  return deepMapCapture(value, (v) => {
    if (typeof v !== "string") {
      return null;
    }
    const dataUri = DATA_URI_RE.exec(v);
    if (dataUri) {
      return {
        replacement: `[stripped data URI ${dataUri[1]}, ${v.length} chars]`,
      };
    }
    if (v.length >= BULK_BASE64_MIN_CHARS && PURE_BASE64_RE.test(v)) {
      return { replacement: `[stripped base64, ${v.length} chars]` };
    }
    return null;
  });
}

/**
 * Replace transcript-item message objects that are identical (by reference)
 * to a `clientMessages` entry with a pointer marker, so the capture carries
 * each message once. Matching is object identity, which is exactly how the
 * duplication arises: transcript items embed the same `DisplayMessage`
 * instances `clientMessages` lists. A structurally-equal copy is not
 * identity-matched and is captured in full, so any divergence between the
 * two surfaces survives; only true duplicates collapse.
 */
export function dedupeAgainstClientMessages(
  transcriptItems: unknown,
  clientMessages: unknown,
): unknown {
  if (!Array.isArray(clientMessages)) {
    return transcriptItems;
  }
  const refs = new Map<object, string>();
  clientMessages.forEach((m, i) => {
    if (m && typeof m === "object") {
      const id = (m as { id?: unknown }).id;
      refs.set(m, typeof id === "string" ? id : `index ${i}`);
    }
  });

  return deepMapCapture(transcriptItems, (v) => {
    if (v === null || typeof v !== "object") {
      return null;
    }
    const ref = refs.get(v);
    return ref !== undefined
      ? { replacement: `[deduplicated: see clientMessages ${ref}]` }
      : null;
  });
}

function buildTarEntry(filename: string, data: Uint8Array): Uint8Array {
  const blockSize = 512;
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

async function buildClientLogsFile(
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
  const tarParts: Uint8Array[] = [
    buildTarEntry("web-client-context.json", contextBytes),
    buildTarEntry("web-chat-diagnostics.json", diagnosticsBytes),
  ];

  // Capture client debug-flag state so flag values are unambiguous during
  // analysis. The flags are localStorage-only overrides with no server
  // targeting, so they can't be reconstructed after the fact — a report has
  // to carry them or the resolved value is lost.
  const debugFlagBytes = new TextEncoder().encode(
    JSON.stringify(buildDebugFlagSnapshot(), null, 2),
  );
  tarParts.push(buildTarEntry("web-debug-flags.json", debugFlagBytes));

  for (const file of extraLogFiles) {
    const contents = file.contents.trim();
    if (contents) {
      tarParts.push(buildTarEntry(file.filename, encoder.encode(contents)));
    }
  }

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
      const clientMessages = debugApi.getClientMessages?.() ?? null;
      const transcriptItems = debugApi.getTranscriptItems?.() ?? null;
      const triagePayload = {
        clientMessages,
        // Transcript items embed the same message objects `clientMessages`
        // lists; carry the item-layer structure (kinds, keys, ordering) with
        // pointers instead of a second full copy of every message.
        transcriptItems: dedupeAgainstClientMessages(
          transcriptItems,
          clientMessages,
        ),
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
      // Message state embeds attachment previews as data URIs and inline
      // base64; strip them to size markers so the capture scales with the
      // conversation's text, not its images.
      const triageBytes = new TextEncoder().encode(
        JSON.stringify(stripBulkBase64(triagePayload), null, 2),
      );
      tarParts.push(
        buildTarEntry("web-chat-debug-api-triage.json", triageBytes),
      );
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
      // SSE event payloads can quote message deltas that embed inline
      // base64; the same strip keeps this member text-sized.
      const triageBytes = new TextEncoder().encode(
        JSON.stringify(stripBulkBase64(triagePayload), null, 2),
      );
      tarParts.push(buildTarEntry("web-sse-liveness-triage.json", triageBytes));
    }
  } catch {
    // Debug API is best-effort; if it's missing or throws, don't block the
    // feedback submission. This can happen during SSR, in tests, or if the
    // chat page hasn't mounted the API yet.
  }

  if (isElectron() && window.vellum?.feedback) {
    try {
      const electronDiagnostics = await window.vellum.feedback.diagnostics();
      const diagBytes = new TextEncoder().encode(
        JSON.stringify(electronDiagnostics, null, 2),
      );
      tarParts.push(buildTarEntry("electron-diagnostics.json", diagBytes));
    } catch {
      /* best-effort */
    }

    try {
      const redactedLogs = await window.vellum.feedback.logs();
      if (redactedLogs) {
        const logBytes = new TextEncoder().encode(redactedLogs);
        tarParts.push(buildTarEntry("electron-main-logs.txt", logBytes));
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
      tarParts.push(buildTarEntry("platform-logs.tar.gz", platformLogsData));
    }
  }

  tarParts.push(new Uint8Array(1024));
  const totalLength = tarParts.reduce((sum, part) => sum + part.length, 0);
  const tarBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of tarParts) {
    tarBuffer.set(part, offset);
    offset += part.length;
  }
  const tarBlob = new Blob([tarBuffer.buffer]);

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
  const { t } = useTranslation();
  const authUser = useAuthStore.use.user();
  const authEmail = authUser?.email;
  const isStaff = authUser?.isStaff ?? false;
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const timeRangeOptions: SelectOption<TimeRange>[] = useMemo(
    () => [
      {
        value: "past_hour",
        label: t("shareFeedbackModal.timeRangePastHour"),
      },
      {
        value: "past_24_hours",
        label: t("shareFeedbackModal.timeRangePast24Hours"),
      },
      {
        value: "all_time",
        label: t("shareFeedbackModal.timeRangeAllTime"),
      },
    ],
    [t],
  );

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

  useBodyScrollLock(open);

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
      const feedbackClient = getFeedbackClient();
      let clientVersion = import.meta.env.VITE_APP_VERSION ?? undefined;
      if (feedbackClient === "electron") {
        try {
          clientVersion =
            (await window.vellum?.app.versionInfo())?.version ?? clientVersion;
        } catch {
          // The web bundle version remains a safe fallback for older shells.
        }
      }
      const submitFeedback = (client: ClientEnum) =>
        mutation.mutateAsync({
          headers: { "Content-Type": null },
          body: {
            message: message.trim(),
            classification: CLASSIFICATION_MAP[selectedReason],
            email: email.trim(),
            client,
            client_version: clientVersion,
            ...(assistantId ? { assistant_id: assistantId } : {}),
            ...(assistantVersion
              ? { assistant_version: assistantVersion }
              : {}),
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
      try {
        await submitFeedback(feedbackClient);
      } catch (err) {
        if (
          feedbackClient !== "android" ||
          !isFeedbackClientValidationError(err)
        ) {
          throw err;
        }
        await submitFeedback("web");
      }
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
      await saveFile(logsFile, logsFile.name);
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
      className={BACKDROP_CLASS}
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className={PANEL_CLASS} style={PANEL_STYLE}>
        <div
          className="flex items-center justify-between border-b pb-4"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <h2
            id={titleId}
            className="!m-0 text-title-small text-[var(--content-default)]"
          >
            {t("shareFeedbackModal.title")}
          </h2>
          <Button
            variant="ghost"
            iconOnly={<X />}
            onClick={onClose}
            disabled={isSubmitting}
            aria-label={t("shareFeedbackModal.closeAria")}
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
                  aria-label={t("shareFeedbackModal.downloadDiagnosticsAria")}
                />
                <span className="text-body-medium-lighter text-[var(--content-default)]">
                  {t("shareFeedbackModal.downloadDiagnostics")}
                </span>
              </label>
              <span className="text-body-small-default text-[var(--content-secondary)]">
                {t("shareFeedbackModal.adminOnlyHint")}
              </span>
            </div>
          )}

          {adminDownloadMode ? (
            <div className="flex items-center gap-3">
              <span className="text-body-medium-lighter text-[var(--content-default)]">
                {t("shareFeedbackModal.timeRange")}
              </span>
              <Select
                options={timeRangeOptions}
                value={logTimeRange}
                onChange={setLogTimeRange}
                aria-label={t("shareFeedbackModal.timeRangeAria")}
              />
            </div>
          ) : (
            <>
              {shouldShowEmail && (
                <Input
                  id={`${titleId}-email`}
                  ref={emailRef}
                  label={t("shareFeedbackModal.email")}
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
                  {t("shareFeedbackModal.category")}
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
                  <Trans
                    ns="common"
                    i18nKey="shareFeedbackModal.bugTip"
                    components={{
                      discordLink: (
                        <a
                          href={VELLUM_COMMUNITY_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline text-[var(--content-default)]"
                        />
                      ),
                    }}
                  />
                </Notice>
              )}

              {selectedReason === "feature_request" && (
                <Notice tone="info">
                  <Trans
                    ns="common"
                    i18nKey="shareFeedbackModal.featureTip"
                    components={{
                      roadmapLink: (
                        <a
                          href="https://vellum.ai/roadmap"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline text-[var(--content-default)]"
                        />
                      ),
                    }}
                  />
                </Notice>
              )}

              <Textarea
                id={`${titleId}-message`}
                ref={messageRef}
                label={
                  selectedReason === "bug_report"
                    ? t("shareFeedbackModal.messageLabelBug")
                    : selectedReason === "feature_request"
                      ? t("shareFeedbackModal.messageLabelFeature")
                      : t("shareFeedbackModal.messageLabelOther")
                }
                rows={3}
                placeholder={
                  selectedReason === "bug_report"
                    ? t("shareFeedbackModal.messagePlaceholderBug")
                    : selectedReason === "feature_request"
                      ? t("shareFeedbackModal.messagePlaceholderFeature")
                      : t("shareFeedbackModal.messagePlaceholderOther")
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
                        aria-label={t(
                          "shareFeedbackModal.includeDiagnosticsAria",
                        )}
                      />
                      <span className="text-body-medium-lighter leading-6 text-[var(--content-default)]">
                        {t("shareFeedbackModal.includeDiagnostics")}
                      </span>
                    </label>
                    <Tooltip content={t("shareFeedbackModal.diagnosticsTooltip")}>
                      <button
                        type="button"
                        aria-label={t("shareFeedbackModal.aboutDiagnosticsAria")}
                        className="inline-flex items-center justify-center text-[var(--content-tertiary)]"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                  {includeLogs && (
                    <Select
                      options={timeRangeOptions}
                      value={logTimeRange}
                      onChange={setLogTimeRange}
                      aria-label={t("shareFeedbackModal.timeRangeAria")}
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
                      aria-label={t(
                        "shareFeedbackModal.includeConversationAria",
                      )}
                    />
                    <span className="text-body-medium-lighter leading-6 text-[var(--content-default)]">
                      {t("shareFeedbackModal.includeConversation")}
                    </span>
                  </label>
                )}

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-body-small-default text-[var(--content-secondary)]">
                    {t("shareFeedbackModal.attachments")}
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
                    {t("shareFeedbackModal.addFiles")}
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
                    {t("shareFeedbackModal.dropFiles")}
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
                ? t("shareFeedbackModal.preparingDiagnostics")
                : t("shareFeedbackModal.sendingFeedback")}
            </span>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t("shareFeedbackModal.cancel")}
              </Button>
              {adminDownloadMode ? (
                <Button
                  variant="primary"
                  leftIcon={<Download />}
                  onClick={handleDownload}
                >
                  {t("shareFeedbackModal.downloadDiagnosticsButton")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  leftIcon={<Send />}
                  onClick={handleSubmit}
                  disabled={!canSend}
                >
                  {t("shareFeedbackModal.submit")}
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
  const { t } = useTranslation();
  const Icon = option.icon;
  const label =
    option.value === "bug_report"
      ? t("shareFeedbackModal.reasonBugReport")
      : option.value === "feature_request"
        ? t("shareFeedbackModal.reasonFeatureRequest")
        : t("shareFeedbackModal.reasonOther");
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
        {label}
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
  const { t } = useTranslation();
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
        aria-label={t("shareFeedbackModal.removeAttachmentAria", {
          name: file.name,
        })}
        className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-black/60 text-white hover:bg-black/70"
        tintColor="#fff"
      />
    </div>
  );
}
