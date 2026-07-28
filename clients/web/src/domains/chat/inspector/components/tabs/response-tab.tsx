import { FileCode } from "lucide-react";
import { type ReactNode } from "react";

import type {
  LLMCallSummary,
  LLMContextSection,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";
import { Card } from "@vellumai/design-library";

import { CopyButton } from "@/domains/chat/inspector/components/copy-button";
import { LlmCallErrorCard } from "@/domains/chat/inspector/components/llm-call-error-card";

interface ResponseTabProps {
  entry: LLMRequestLogEntry;
}

/**
 * Response tab rendering a metadata card (stop reason + mode label)
 * followed by per-section cards keyed on presentation kind. When the call
 * failed, a failure banner replaces the generic "section rendering
 * unavailable" fallback so the rejected response reads as an error.
 */
export function ResponseTab({ entry }: ResponseTabProps): ReactNode {
  const error = entry.error ?? null;
  const sections = buildSectionModels(entry.responseSections ?? []);
  const stopReason = deriveStopReason(entry.summary);
  const modeLabel = deriveModeLabel(entry.summary, sections);
  const hasMetadata = stopReason != null || modeLabel != null;

  if (!sections.length && !hasMetadata) {
    return (
      <div className="flex flex-col gap-4 p-4">
        {error ? (
          <LlmCallErrorCard error={error} />
        ) : (
          <FallbackCard message={null} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {error && <LlmCallErrorCard error={error} />}
      {hasMetadata && (
        <Card>
          <p
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            Response metadata
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {stopReason && (
              <MetadataChip label={`Stop reason: ${stopReason}`} />
            )}
            {modeLabel && <MetadataChip label={modeLabel} />}
          </div>
        </Card>
      )}

      {sections.length > 0
        ? sections.map((s) => <ResponseSectionCard key={s.id} section={s} />)
        : !error && <FallbackCard message={null} />}
    </div>
  );
}

interface ResponseSectionCardProps {
  section: ResponseSectionModel;
}

function ResponseSectionCard({ section }: ResponseSectionCardProps): ReactNode {
  switch (section.kind) {
    case "toolCall":
      return <ToolCallCard section={section} />;
    default:
      return <TextCard section={section} />;
  }
}

function TextCard({ section }: ResponseSectionCardProps): ReactNode {
  return (
    <Card>
      <SectionHeader section={section} />
      {section.bodyText ? (
        <p
          className="mt-3 select-text whitespace-pre-wrap text-body-medium-lighter"
          style={{ color: "var(--content-default)" }}
        >
          {section.bodyText}
        </p>
      ) : (
        <p
          className="mt-3 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          No assistant text was captured for this section.
        </p>
      )}
    </Card>
  );
}

function ToolCallCard({ section }: ResponseSectionCardProps): ReactNode {
  return (
    <Card>
      <SectionHeader section={section} />
      {section.toolName && (
        <div className="mt-2">
          <MetadataChip label={`Tool: ${section.toolName}`} />
        </div>
      )}
      {section.bodyText ? (
        <div className="mt-3">
          <p
            className="mb-1 text-label-default"
            style={{ color: "var(--content-secondary)" }}
          >
            Arguments preview
          </p>
          <p
            className="select-text whitespace-pre-wrap text-body-small-default"
            style={{ color: "var(--content-default)" }}
          >
            {section.bodyText}
          </p>
        </div>
      ) : (
        <p
          className="mt-3 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          No structured arguments preview is available for this tool call.
        </p>
      )}
      <div
        className="mt-3 rounded-md px-3 py-2 text-label-default"
        style={{
          background: "var(--surface-overlay)",
          color: "var(--content-secondary)",
        }}
      >
        Need the full provider payload? Open the Raw tab for request and
        response JSON.
      </div>
    </Card>
  );
}

function FallbackCard({ message }: { message: string | null }): ReactNode {
  return (
    <Card>
      <div className="flex items-center gap-2">
        <FileCode
          size={14}
          aria-hidden
          style={{ color: "var(--content-tertiary)" }}
        />
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Section rendering unavailable
        </span>
      </div>
      <p
        className="mt-2 text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        {message ??
          "This response has no rendered sections. Raw payloads remain available in the Raw tab, and any normalized response metadata will still be shown when present."}
      </p>
    </Card>
  );
}

function SectionHeader({
  section,
}: {
  section: ResponseSectionModel;
}): ReactNode {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <p
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {section.title}
        </p>
        <div className="mt-0.5">
          <MetadataChip label={section.kindLabel} />
        </div>
      </div>
      <CopyButton text={section.copyText} ariaLabel="Copy section content" />
    </div>
  );
}

function MetadataChip({ label }: { label: string }): ReactNode {
  return (
    <span
      className="inline-block rounded px-2 py-0.5 text-label-default"
      style={{
        background: "var(--surface-overlay)",
        color: "var(--content-secondary)",
      }}
    >
      {label}
    </span>
  );
}

type PresentationKind =
  | "assistantText"
  | "reasoning"
  | "toolCall"
  | "result"
  | "other";

interface ResponseSectionModel {
  id: number;
  kind: PresentationKind;
  title: string;
  kindLabel: string;
  bodyText: string | null;
  toolName: string | null;
  copyText: string;
}

const TEXT_KINDS = new Set([
  "assistant",
  "message",
  "text",
  "output",
  "completion",
  "markdown",
  "code",
  "json",
]);

const TOOL_CALL_KINDS = new Set(["tool", "tool_use", "function_call"]);

const RESULT_KINDS = new Set(["tool_result", "function_response"]);

function toPresentationKind(kind: string): PresentationKind {
  const k = kind.toLowerCase();
  if (TOOL_CALL_KINDS.has(k)) return "toolCall";
  if (RESULT_KINDS.has(k)) return "result";
  if (k === "reasoning") return "reasoning";
  if (TEXT_KINDS.has(k)) return "assistantText";
  return "other";
}

function kindDisplayLabel(
  kind: string,
  presentationKind: PresentationKind,
): string {
  switch (presentationKind) {
    case "toolCall":
      return "Tool call";
    case "result":
      return kind.toLowerCase() === "function_response"
        ? "Function response"
        : "Tool result";
    case "reasoning":
      return "Reasoning";
    case "assistantText":
      return "Assistant text";
    default:
      return kind;
  }
}

function sectionBodyText(section: LLMContextSection): string | null {
  if (section.text != null) return section.text;
  if (section.data != null) {
    try {
      return JSON.stringify(section.data, null, 2);
    } catch {
      return String(section.data);
    }
  }
  return null;
}

function buildSectionModels(
  sections: LLMContextSection[],
): ResponseSectionModel[] {
  return sections.map((section, index) => {
    const pKind = toPresentationKind(section.kind);
    const rawTitle = section.label?.trim() ?? "";
    const title = rawTitle || `Section ${index + 1}`;
    const body = sectionBodyText(section);
    return {
      id: index,
      kind: pKind,
      title,
      kindLabel: kindDisplayLabel(section.kind, pKind),
      bodyText: body,
      toolName: section.toolName ?? null,
      copyText: body ?? title,
    };
  });
}

function deriveStopReason(summary?: LLMCallSummary | null): string | null {
  const raw = summary?.stopReason?.trim();
  return raw || null;
}

function isToolCallingStop(stopReason: string | null): boolean {
  if (!stopReason) return false;
  return ["tool_calls", "tool_use", "function_call", "function_calls"].includes(
    stopReason.toLowerCase().trim(),
  );
}

function deriveModeLabel(
  summary: LLMCallSummary | null | undefined,
  sections: ResponseSectionModel[],
): string | null {
  if (summary?.responseToolCallCount && summary.responseToolCallCount > 0) {
    return "Tool-calling response";
  }
  if (isToolCallingStop(summary?.stopReason ?? null)) {
    return "Tool-calling response";
  }
  if (!sections.length) return null;
  if (sections.some((s) => s.kind === "toolCall"))
    return "Tool-calling response";
  const hasText = sections.some((s) => s.kind === "assistantText");
  const hasResult = sections.some((s) => s.kind === "result");
  if (hasText && !hasResult) return "Text-only response";
  if (hasResult && !hasText) return "Result-only response";
  return null;
}
