import { Copy } from "lucide-react";
import { type ReactNode } from "react";

import { ToolDefinitionsCard } from "@/domains/chat/inspector/components/tool-definitions-card";
import { parseToolDefinitions } from "@/domains/chat/inspector/tool-definitions";
import type {
    LLMContextSection,
    LLMRequestLogEntry,
} from "@vellumai/assistant-api";
import { Button, Card } from "@vellumai/design-library";

interface PromptTabProps {
  entry: LLMRequestLogEntry;
}

/**
 * Prompt tab rendering each normalized request section as a card.
 * Every section renders as raw `<pre>` text so the prompt is shown
 * exactly as sent — no Markdown formatting applied. Structured payloads
 * and tool output stay in a capped scroll box (they can be huge);
 * prompt text renders uncapped so the full prompt is readable inline.
 * Tool definitions render as an expandable per-tool breakdown. The raw
 * provider JSON lives on the Raw tab.
 */
export function PromptTab({ entry }: PromptTabProps): ReactNode {
  const sections = entry.requestSections ?? [];

  const bannerText =
    sections.length === 0
      ? "This call has no normalized prompt sections yet."
      : `${sections.length} normalized request section${sections.length === 1 ? "" : "s"} shown in the order returned by the assistant route.`;

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card>
        <p
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Prompt sections
        </p>
        <p
          className="mt-1 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          {bannerText}
        </p>
      </Card>

      {sections.length === 0 ? (
        <EmptyState />
      ) : (
        sections.map((section, i) => {
          if (section.kind === "tool_definitions") {
            const tools = parseToolDefinitions(section.data);
            if (tools) {
              return <ToolDefinitionsCard key={i} tools={tools} />;
            }
          }
          return <SectionCard key={i} section={section} index={i} />;
        })
      )}
    </div>
  );
}

function EmptyState(): ReactNode {
  return (
    <Card>
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        No normalized prompt sections
      </p>
      <p
        className="mt-1 text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        This call has no normalized prompt sections. Use the Raw tab to inspect
        the full request payload.
      </p>
    </Card>
  );
}

interface SectionCardProps {
  section: LLMContextSection;
  index: number;
}

function SectionCard({ section, index }: SectionCardProps): ReactNode {
  const title = sectionTitle(section, index);
  const kind = humanKindLabel(section.kind);
  const formatLabel = languageFormatLabel(section.language ?? null);
  const { text, isStructured } = renderContent(section);
  // Tool output and structured payloads can be huge, so cap their height
  // into a scroll box; prompt text stays uncapped for inline reading.
  const capHeight = isStructured || isToolResultKind(section.kind);

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {title}
          </p>
          <div className="mt-0.5 flex items-center gap-2">
            <span
              className="text-label-default"
              style={{ color: "var(--content-tertiary)" }}
            >
              {kind}
            </span>
            {formatLabel && (
              <span
                className="text-label-default"
                style={{ color: "var(--content-secondary)" }}
              >
                {formatLabel}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          leftIcon={<Copy size={14} aria-hidden />}
          aria-label={`Copy ${title}`}
          onClick={() => void navigator.clipboard.writeText(text)}
        />
      </div>

      <pre
        className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-body-small-default"
        style={{
          background: "var(--surface-base)",
          color: "var(--content-default)",
          ...(capHeight ? { maxHeight: "320px" } : {}),
        }}
      >
        {text}
      </pre>
    </Card>
  );
}

function isToolResultKind(kind: string): boolean {
  return kind === "tool_result" || kind === "function_response";
}

function sectionTitle(section: LLMContextSection, index: number): string {
  const lbl = section.label?.trim();
  if (lbl) return lbl;
  return `${humanKindLabel(section.kind)} ${index + 1}`;
}

function humanKindLabel(kind: string): string {
  return kind
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function languageFormatLabel(language: string | null): string | null {
  if (!language) return null;
  switch (language.toLowerCase()) {
    case "json":
    case "application/json":
      return "JSON";
    case "markdown":
    case "md":
    case "text/markdown":
      return "Markdown";
    case "javascript":
    case "application/javascript":
    case "text/javascript":
      return "JavaScript";
    case "typescript":
    case "application/typescript":
    case "text/typescript":
      return "TypeScript";
    default:
      return null;
  }
}

function renderContent(section: LLMContextSection): {
  text: string;
  isStructured: boolean;
} {
  if (section.text != null) {
    return { text: section.text, isStructured: false };
  }
  if (section.data != null) {
    try {
      return {
        text: JSON.stringify(section.data, null, 2),
        isStructured: true,
      };
    } catch {
      return { text: String(section.data), isStructured: false };
    }
  }
  return { text: "No content available.", isStructured: false };
}
