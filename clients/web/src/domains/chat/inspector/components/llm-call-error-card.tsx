import { TriangleAlert } from "lucide-react";
import { type ReactNode } from "react";

import { displayProvider } from "@/domains/chat/inspector/inspector-formatters";
import type { LLMCallError } from "@vellumai/assistant-api";
import { Card } from "@vellumai/design-library";

/**
 * Failure banner shared by the Overview and Response tabs. Rendered when a
 * call's `error` field is populated — i.e. the provider rejected the
 * request before producing a response. Surfaces the provider's message
 * plus any structured metadata (type, provider, HTTP status, error code)
 * so a failed call reads as a failure instead of an empty/normalized row.
 */
export function LlmCallErrorCard({
  error,
}: {
  error: LLMCallError;
}): ReactNode {
  const message = error.message?.trim();
  const chips = buildErrorChips(error);

  return (
    <Card>
      <div className="flex items-center gap-2">
        <TriangleAlert
          size={14}
          aria-hidden
          style={{ color: "var(--system-negative-strong)" }}
        />
        <span
          className="text-body-medium-default"
          style={{ color: "var(--system-negative-strong)" }}
        >
          Call failed
        </span>
      </div>
      <p
        className="mt-2 select-text whitespace-pre-wrap break-words text-body-medium-lighter"
        style={{ color: "var(--content-default)" }}
      >
        {message && message.length > 0
          ? message
          : "The provider rejected this call and returned no response."}
      </p>
      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <ErrorChip key={chip.label} label={chip.label} value={chip.value} />
          ))}
        </div>
      )}
    </Card>
  );
}

interface ErrorChipModel {
  label: string;
  value: string;
}

function buildErrorChips(error: LLMCallError): ErrorChipModel[] {
  const chips: ErrorChipModel[] = [];
  const name = error.name?.trim();
  if (name) {
    chips.push({ label: "Type", value: name });
  }
  const provider = error.provider?.trim();
  if (provider) {
    chips.push({ label: "Provider", value: displayProvider(provider) });
  }
  if (
    typeof error.statusCode === "number" &&
    Number.isFinite(error.statusCode)
  ) {
    chips.push({ label: "Status", value: String(error.statusCode) });
  }
  const code = error.code?.trim();
  if (code) {
    chips.push({ label: "Code", value: code });
  }
  const apiErrorCode = error.apiErrorCode?.trim();
  if (apiErrorCode) {
    chips.push({ label: "Upstream code", value: apiErrorCode });
  }
  const apiErrorType = error.apiErrorType?.trim();
  if (apiErrorType) {
    chips.push({ label: "Upstream type", value: apiErrorType });
  }
  const apiErrorParam = error.apiErrorParam?.trim();
  if (apiErrorParam) {
    chips.push({ label: "Upstream param", value: apiErrorParam });
  }
  const requestId = error.requestId?.trim();
  if (requestId) {
    chips.push({ label: "Request ID", value: requestId });
  }
  return chips;
}

function ErrorChip({ label, value }: ErrorChipModel): ReactNode {
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded px-2 py-0.5 text-label-default"
      style={{
        background: "var(--surface-overlay)",
        color: "var(--content-secondary)",
      }}
    >
      <span>{label}</span>
      <span className="font-medium" style={{ color: "var(--content-default)" }}>
        {value}
      </span>
    </span>
  );
}
