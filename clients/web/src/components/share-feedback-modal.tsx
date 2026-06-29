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
import type { ClassificationEnum } from "@/generated/api/types.gen";
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

type Reason = "bug_report" | "feature_request" | "other";

type TimeRange = "past_hour" | "past_24_hours" | "all_time";

interface ReasonOption {
  value: Reason;
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

const CLASSIFICATION_MAP: Record<Reason, ClassificationEnum> = {
  bug_report: "bug_report",
  feature_request: "feature_request",
  other: "other",
};

function getFeedbackClient(): "electron" | "ios" | "web" {
  if (isElectron()) {
    return "electron";
  }
  return Capacitor.getPlatform() === "ios" ? "ios" : "web";
}

type FeedbackDiagnosticsProvider = () => Record<string, unknown> | null;

interface LogExportWindow {
  startTime: number | null;
  endTime: number;
}

function isAllowedFile(file: File): boolean {
  if (file.size > MAX_ATTACHMENT_BYTES) return false;
  if (file.type && ALLOWED_MIME_TYPES.has(file.type)) return true;
  if (!file.type) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    return ext ? ALLOWED_EXTENSIONS.has(ext) : false;
  }
  return false;
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
  for (let i = 148; i < 156; i++) buffer[i] = 0x20;
  buffer[156] = 0x30;
  writeAscii("ustar\0", 257, 6);
  writeAscii("00", 263, 2);

  let checksum = 0;
  for (let i = 0; i < blockSize; i++) checksum += buffer[i]!;
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

async function buildClientLogsFile(
  timeRange: TimeRange,
  assistantId: string | null,
  activeConversationId: string | null,
  diagnosticsProvider?: FeedbackDiagnosticsProvider,
): Promise<File | null> {
  if (typeof CompressionStream === "undefined") {
    return null;
  }
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
  const contextBytes = new TextEncoder().encode(
    JSON.stringify(payload, null, 2),
  );
  const diagnosticsBytes = new TextEncoder().encode(
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
      const triageBytes = new TextEncoder().encode(
        JSON.stringify(triagePayload, null, 2),
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
    } catch { /* best-effort */ }

    try {
      const redactedLogs = await window.vellum.feedback.logs();
      if (redactedLogs) {
        const logBytes = new TextEncoder().encode(redactedLogs);
        tarParts.push(buildTarEntry("electron-main-logs.txt", logBytes));
      }
    } catch { /* best-effort */ }
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
  initialReason?: Reason;
  onSubmitted?: () => void;
  assistantId?: string | null;
  assistantVersion?: string | null;
  activeConversationId?: string | null;
  getDiagnosticsSnapshot?: FeedbackDiagnosticsProvider;
}

export function ShareFeedbackModal({
  open,
  onClose,
  initialReason,
  onSubmitted,
  assistantId,
  assistantVersion,
  activeConversationId,
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

  const [selectedReason, setSelectedReason] = useState<Reason>(
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
    if (!open) return;
    const reason = initialReason ?? "bug_report";
    setSelectedReason(reason);
    setMessage("");
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
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const handleSelectReason = (reason: Reason) => {
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

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) {
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
      if (remaining <= 0) return current;
      const existingKeys = new Set(current.map((f) => `${f.name}:${f.size}`));
      const accepted: File[] = [];
      for (const file of files) {
        if (accepted.length >= remaining) break;
        if (!isAllowedFile(file)) continue;
        const key = `${file.name}:${file.size}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        accepted.push(file);
      }
      return accepted.length > 0 ? [...current, ...accepted] : current;
    });
  }, []);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = "";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length)
      addFiles(Array.from(e.dataTransfer.files));
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.currentTarget === e.target) setIsDragging(false);
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
              isElectron() ? (includeConversation ? (activeConversationId ?? null) : null) : (activeConversationId ?? null),
              getDiagnosticsSnapshot,
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
          ...(logsFile ? { logs_file: logsFile } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
        bodySerializer: (body) => {
          const form = new FormData();
          for (const [key, value] of Object.entries(
            body as Record<string, unknown>,
          )) {
            if (value == null) continue;
            if (key === "attachments" && Array.isArray(value)) {
              for (const file of value)
                form.append("attachments", file as Blob);
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
        getDiagnosticsSnapshot,
      );
      if (!logsFile) {
        setSubmitError(
          "Diagnostics export isn't supported in this browser.",
        );
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

  if (!open) return null;

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
                downloads it instead of submitting feedback or notifying
                Slack.
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

          {isElectron() && activeConversationId && selectedReason !== "feature_request" && (
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
              {adminDownloadMode ? "Preparing diagnostics…" : "Sending feedback…"}
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
    if (!previewUrl) return;
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
