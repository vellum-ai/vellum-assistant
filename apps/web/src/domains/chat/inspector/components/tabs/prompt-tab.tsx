import { Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button, Card, SegmentControl } from "@vellum/design-library";
import type {
  LLMContextSection,
  LLMRequestLogEntry,
} from "@/domains/chat/types/inspector-types.js";
import { FileMarkdown } from "@/domains/intelligence/components/file-markdown.js";

interface PromptTabProps {
  entry: LLMRequestLogEntry;
}

type ViewMode = "markdown" | "raw";

/**
 * Prompt tab rendering each normalized request section as a card.
 * Text sections render as Markdown by default; a Markdown/Raw segmented
 * control flips the entire tab to plain `<pre>` text. Structured
 * payloads always render as `<pre>` regardless of mode.
 */
export function PromptTab({ entry }: PromptTabProps): ReactNode {
  const sections = entry.requestSections ?? [];
  const [viewMode, setViewMode] = useState<ViewMode>("markdown");

  const bannerText =
    sections.length === 0
      ? "This call has no normalized prompt sections yet."
      : `${sections.length} normalized request section${sections.length === 1 ? "" : "s"} shown in the order returned by the assistant route.`;

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
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
          </div>
          {sections.length > 0 && (
            <SegmentControl<ViewMode>
              ariaLabel="Prompt rendering mode"
              value={viewMode}
              onChange={setViewMode}
              items={[
                { value: "markdown", label: "Markdown" },
                { value: "raw", label: "Raw" },
              ]}
            />
          )}
        </div>
      </Card>

      {sections.length === 0 ? (
        <EmptyState />
      ) : (
        sections.map((section, i) => (
          <SectionCard
            key={i}
            section={section}
            index={i}
            viewMode={viewMode}
          />
        ))
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
  viewMode: ViewMode;
}

function SectionCard({
  section,
  index,
  viewMode,
}: SectionCardProps): ReactNode {
  const title = sectionTitle(section, index);
  const kind = humanKindLabel(section.kind);
  const formatLabel = languageFormatLabel(section.language ?? null);
  const { text, isStructured } = renderContent(section);
  const renderAsMarkdown = !isStructured && viewMode === "markdown";

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

      {isStructured ? (
        <pre
          className="mt-3 overflow-auto rounded-md p-3 text-body-small-default"
          style={{
            background: "var(--surface-base)",
            color: "var(--content-default)",
            maxHeight: "320px",
          }}
        >
          {text}
        </pre>
      ) : renderAsMarkdown ? (
        <div
          className="mt-3 min-w-0 break-words"
          style={{ color: "var(--content-default)" }}
        >
          <FileMarkdown content={text} stripFrontmatter={false} />
        </div>
      ) : (
        <p
          className="mt-3 select-text whitespace-pre-wrap break-words text-body-medium-lighter"
          style={{ color: "var(--content-default)" }}
        >
          {text}
        </p>
      )}
    </Card>
  );
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
