import { ChevronRight, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

import { CacheDiffCard } from "@/domains/chat/inspector/components/cache-diff-card";
import { CacheHealthCard } from "@/domains/chat/inspector/components/cache-health-card";
import { ToolDefinitionsContent } from "@/domains/chat/inspector/components/tool-definitions-content";
import { parseToolDefinitions } from "@/domains/chat/inspector/tool-definitions";
import type {
  LLMContextSection,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";
import { Button, Card, Collapsible } from "@vellumai/design-library";

interface PromptTabProps {
  entry: LLMRequestLogEntry;
  previous: LLMRequestLogEntry | null;
  assistantId: string | undefined;
}

/**
 * Prompt tab: a cache-health summary pinned at the top, followed by each
 * normalized request section as a collapsible card. Sections start
 * expanded and can be folded individually or all at once so a reader can
 * skip past a long prompt to the cache breakdown. Section bodies render as
 * raw `<pre>` text so the prompt is shown exactly as sent — no Markdown
 * formatting applied. Structured payloads and tool output stay in a capped
 * scroll box (they can be huge); prompt text renders uncapped so the full
 * prompt is readable inline. Tool definitions render as an expandable
 * per-tool breakdown. The raw provider JSON lives on the Raw tab. A
 * cache-diff panel below the cache-health summary names the block that
 * diverged from the previous turn's request.
 */
export function PromptTab({
  entry,
  previous,
  assistantId,
}: PromptTabProps): ReactNode {
  const sections = entry.requestSections ?? [];
  const sectionIds = sections.map((_, i) => `section-${i}`);

  const [openSections, setOpenSections] = useState<string[]>(sectionIds);
  // Reset the open-state when switching to a different call so the newly
  // selected call starts fully expanded instead of inheriting stale ids.
  const [trackedEntryId, setTrackedEntryId] = useState(entry.id);
  if (trackedEntryId !== entry.id) {
    setTrackedEntryId(entry.id);
    setOpenSections(sectionIds);
  }

  const allExpanded =
    sectionIds.length > 0 && openSections.length === sectionIds.length;

  const bannerText =
    sections.length === 0
      ? "This call has no normalized prompt sections yet."
      : `${sections.length} normalized request section${sections.length === 1 ? "" : "s"} shown in the order returned by the assistant route.`;

  return (
    <div className="flex flex-col gap-4 p-4">
      <CacheHealthCard summary={entry.summary} />

      <CacheDiffCard
        current={entry}
        previous={previous}
        assistantId={assistantId}
      />

      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
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
            <Button
              variant="ghost"
              size="compact"
              className="shrink-0"
              onClick={() =>
                setOpenSections(allExpanded ? [] : [...sectionIds])
              }
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </Button>
          )}
        </div>
      </Card>

      {sections.length === 0 ? (
        <EmptyState />
      ) : (
        <Collapsible.Root
          type="multiple"
          value={openSections}
          onValueChange={setOpenSections}
          className="gap-4"
        >
          {sections.map((section, i) => (
            <PromptSectionItem
              key={sectionIds[i]}
              value={sectionIds[i]}
              section={section}
              index={i}
            />
          ))}
        </Collapsible.Root>
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

interface PromptSectionItemProps {
  section: LLMContextSection;
  index: number;
  value: string;
}

function PromptSectionItem({
  section,
  index,
  value,
}: PromptSectionItemProps): ReactNode {
  const toolDefs =
    section.kind === "tool_definitions"
      ? parseToolDefinitions(section.data)
      : null;

  const title = toolDefs
    ? section.label?.trim() || "Available tools"
    : sectionTitle(section, index);
  const kind = humanKindLabel(section.kind);
  const formatLabel = toolDefs
    ? null
    : languageFormatLabel(section.language ?? null);
  const { text, isStructured } = renderContent(section);
  // Tool output and structured payloads can be huge, so cap their height
  // into a scroll box; prompt text stays uncapped for inline reading.
  const capHeight = isStructured || isToolResultKind(section.kind);

  return (
    <Collapsible.Item
      value={value}
      className="relative rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)]"
    >
      <Collapsible.Trigger className="group items-start gap-3 p-4 pr-12 text-left">
        <ChevronRight
          size={14}
          aria-hidden
          className="mt-0.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          style={{ color: "var(--content-tertiary)" }}
        />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {title}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
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
          </span>
        </span>
      </Collapsible.Trigger>

      {!toolDefs && (
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<Copy aria-hidden />}
          aria-label={`Copy ${title}`}
          className="absolute right-2 top-3"
          onClick={() => void navigator.clipboard.writeText(text)}
        />
      )}

      <Collapsible.Content>
        {toolDefs ? (
          <div className="px-4 pb-4">
            <ToolDefinitionsContent tools={toolDefs} />
          </div>
        ) : (
          <pre
            className="mx-4 mb-4 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-body-small-default"
            style={{
              background: "var(--surface-base)",
              color: "var(--content-default)",
              ...(capHeight ? { maxHeight: "320px" } : {}),
            }}
          >
            {text}
          </pre>
        )}
      </Collapsible.Content>
    </Collapsible.Item>
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
