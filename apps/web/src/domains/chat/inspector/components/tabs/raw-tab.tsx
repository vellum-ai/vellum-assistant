import { AlertCircle, Copy, Download, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useLlmLogPayload } from "@/domains/chat/inspector/inspector-payload-api";
import { captureError } from "@/lib/sentry/capture-error";
import type { LLMRequestLogEntry } from "@vellumai/assistant-api";
import { Button, Card } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

type RawPane = "request" | "response";

interface RawTabProps {
  entry: LLMRequestLogEntry;
  assistantId: string | undefined;
}

/**
 * Raw tab — lazily fetches the full provider JSON for the selected call.
 * Exposes a Request/Response toggle, copy action, and download action
 * for each pane. Payloads are cached for 5 minutes (immutable).
 */
export function RawTab({ entry, assistantId }: RawTabProps): ReactNode {
  const [pane, setPane] = useState<RawPane>("request");
  const { data, isLoading, isError, error, refetch } = useLlmLogPayload(
    assistantId,
    entry.id,
  );

  if (isLoading) {
    return <LoadingState />;
  }

  if (isError) {
    const msg =
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "The payload request failed. Try again.";
    return <ErrorState message={msg} onRetry={() => void refetch()} />;
  }

  const rawValue = pane === "request" ? data?.requestPayload : data?.responsePayload;
  const displayText = formatPayload(rawValue);
  const downloadFilename = buildRawPayloadFilename(entry.id, pane);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        {(["request", "response"] as RawPane[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPane(p)}
            className="rounded-md px-3 py-1 text-label-medium-default transition-colors"
            style={{
              background: pane === p ? "var(--surface-overlay)" : "transparent",
              color:
                pane === p ? "var(--content-default)" : "var(--content-secondary)",
              border: "1px solid var(--border-base)",
            }}
          >
            {p === "request" ? "Request" : "Response"}
          </button>
        ))}
      </div>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <span
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {pane === "request" ? "Request payload" : "Response payload"}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              leftIcon={<Download size={14} aria-hidden />}
              aria-label={`Download ${pane} payload`}
              onClick={() =>
                void downloadRawPayload(displayText, downloadFilename)
              }
            />
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              leftIcon={<Copy size={14} aria-hidden />}
              aria-label={`Copy ${pane} payload`}
              onClick={() => void navigator.clipboard.writeText(displayText)}
            />
          </div>
        </div>
        <pre
          className="mt-3 overflow-auto rounded-md p-3 text-body-small-default"
          style={{
            background: "var(--surface-base)",
            color: "var(--content-default)",
            maxHeight: "calc(100vh - 320px)",
            minHeight: "120px",
          }}
        >
          {displayText}
        </pre>
      </Card>
    </div>
  );
}

export function formatPayload(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function buildRawPayloadFilename(logId: string, pane: RawPane): string {
  const safeLogId = logId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `llm-${safeLogId}-${pane}.json`;
}

async function downloadRawPayload(
  text: string,
  filename: string,
): Promise<void> {
  try {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const { saveFile } = await import("@/runtime/native-file");
    await saveFile(blob, filename);
  } catch (error) {
    captureError(error, { context: "download_raw_payload" });
    toast.error("Failed to download the payload.");
  }
}

function LoadingState(): ReactNode {
  return (
    <div className="flex h-48 w-full flex-col items-center justify-center gap-2">
      <p
        className="text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Loading raw payloads…
      </p>
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry: () => void;
}

function ErrorState({ message, onRetry }: ErrorStateProps): ReactNode {
  return (
    <div className="flex h-48 w-full flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertCircle
        size={28}
        aria-hidden
        style={{ color: "var(--content-secondary)" }}
      />
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Couldn&rsquo;t load raw payloads
      </p>
      <p
        className="max-w-xs text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {message}
      </p>
      <Button
        variant="outlined"
        size="compact"
        leftIcon={<RefreshCw size={14} aria-hidden />}
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}
