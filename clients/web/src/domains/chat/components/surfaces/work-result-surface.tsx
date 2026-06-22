import {
  ArrowLeftRight,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  FileText,
  ListChecks,
  OctagonX,
} from "lucide-react";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { filterRecords, rec, strOrNum } from "@/domains/chat/components/surfaces/surface-parse-helpers";

type WorkResultStatus = "completed" | "partial" | "failed" | "in_progress";
type WorkResultTone = "neutral" | "positive" | "warning" | "negative";
type WorkResultSectionType =
  | "items"
  | "timeline"
  | "diff"
  | "artifacts"
  | "warnings";

interface WorkResultMetric {
  label: string;
  value: string | number;
  detail?: string;
  tone?: WorkResultTone;
}

interface WorkResultMetadata {
  label: string;
  value: string | number;
}

interface WorkResultItem {
  id?: string;
  title: string;
  description?: string;
  status?: string;
  tone?: WorkResultTone;
  metadata?: WorkResultMetadata[];
  href?: string;
}

interface WorkResultDiff {
  label?: string;
  before?: string;
  after?: string;
}

interface WorkResultSection {
  id?: string;
  title: string;
  description?: string;
  type?: WorkResultSectionType;
  items?: WorkResultItem[];
  diffs?: WorkResultDiff[];
}

interface WorkResultSurfaceData {
  eyebrow?: string;
  status?: WorkResultStatus;
  summary?: string;
  metrics?: WorkResultMetric[];
  sections?: WorkResultSection[];
}

interface WorkResultSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

const STATUS_COPY: Record<
  WorkResultStatus,
  { label: string; tone: WorkResultTone }
> = {
  completed: { label: "Completed", tone: "positive" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Needs attention", tone: "negative" },
  in_progress: { label: "In progress", tone: "neutral" },
};

/** Narrow unknown → non-empty string. Rejects whitespace-only. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asTone(value: unknown): WorkResultTone | undefined {
  return value === "positive" ||
    value === "warning" ||
    value === "negative" ||
    value === "neutral"
    ? value
    : undefined;
}

function asStatus(value: unknown): WorkResultStatus | undefined {
  return value === "completed" ||
    value === "partial" ||
    value === "failed" ||
    value === "in_progress"
    ? value
    : undefined;
}

function asSectionType(value: unknown): WorkResultSectionType | undefined {
  return value === "items" ||
    value === "timeline" ||
    value === "diff" ||
    value === "artifacts" ||
    value === "warnings"
    ? value
    : undefined;
}

function parseMetadata(value: unknown): WorkResultMetadata[] {
  return filterRecords(value).flatMap((item) => {
    const label = asString(item.label);
    const metricValue = strOrNum(item.value);
    return label && metricValue !== undefined
      ? [{ label, value: metricValue }]
      : [];
  });
}

function parseItems(value: unknown): WorkResultItem[] {
  return filterRecords(value).flatMap((item, index) => {
    const title = asString(item.title);
    if (!title) return [];
    return [
      {
        id: asString(item.id) ?? `${index}`,
        title,
        description: asString(item.description),
        status: asString(item.status),
        tone: asTone(item.tone),
        metadata: parseMetadata(item.metadata),
        href: asString(item.href),
      },
    ];
  });
}

function parseDiffs(value: unknown): WorkResultDiff[] {
  return filterRecords(value).flatMap((item) => {
    const before = asString(item.before);
    const after = asString(item.after);
    if (!before && !after) return [];
    return [
      {
        label: asString(item.label),
        before,
        after,
      },
    ];
  });
}

function parseMetrics(value: unknown): WorkResultMetric[] {
  return filterRecords(value).flatMap((item) => {
    const label = asString(item.label);
    const metricValue = strOrNum(item.value);
    if (!label || metricValue === undefined) return [];
    return [
      {
        label,
        value: metricValue,
        detail: asString(item.detail),
        tone: asTone(item.tone),
      },
    ];
  });
}

function parseSections(value: unknown): WorkResultSection[] {
  return filterRecords(value).flatMap((section, index) => {
    const title = asString(section.title);
    if (!title) return [];
    return [
      {
        id: asString(section.id) ?? `${index}`,
        title,
        description: asString(section.description),
        type: asSectionType(section.type),
        items: parseItems(section.items),
        diffs: parseDiffs(section.diffs),
      },
    ];
  });
}

function parseData(value: unknown): WorkResultSurfaceData {
  const obj = rec(value);
  if (!obj) return {};
  return {
    eyebrow: asString(obj.eyebrow),
    status: asStatus(obj.status),
    summary: asString(obj.summary),
    metrics: parseMetrics(obj.metrics),
    sections: parseSections(obj.sections),
  };
}

function toneClasses(tone: WorkResultTone | undefined): {
  text: string;
  bg: string;
  rail: string;
} {
  switch (tone) {
    case "positive":
      return {
        text: "text-[var(--system-positive-strong)]",
        bg: "bg-[var(--system-positive-weak)]",
        rail: "bg-[var(--system-positive-strong)]",
      };
    case "warning":
      return {
        text: "text-[var(--system-mid-strong)]",
        bg: "bg-[var(--system-mid-weak)]",
        rail: "bg-[var(--system-mid-strong)]",
      };
    case "negative":
      return {
        text: "text-[var(--system-negative-strong)]",
        bg: "bg-[var(--system-negative-weak)]",
        rail: "bg-[var(--system-negative-strong)]",
      };
    default:
      return {
        text: "text-[var(--content-secondary)]",
        bg: "bg-[var(--surface-base)]",
        rail: "bg-[var(--border-element)]",
      };
  }
}

function ResultStatusBadge({ status }: { status?: WorkResultStatus }) {
  if (!status) return null;
  const config = STATUS_COPY[status];
  const tone = toneClasses(config.tone);
  const Icon =
    status === "completed"
      ? CircleCheck
      : status === "partial"
        ? CircleAlert
        : status === "failed"
          ? OctagonX
          : Clock3;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-label-small-default ${tone.bg} ${tone.text}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </span>
  );
}

function MetricGrid({ metrics }: { metrics: WorkResultMetric[] }) {
  if (metrics.length === 0) return null;
  return (
    <div className="mt-4 grid gap-px overflow-hidden rounded-md border border-[var(--border-base)] bg-[var(--border-base)] sm:grid-cols-3">
      {metrics.map((metric) => {
        const tone = toneClasses(metric.tone);
        return (
          <div
            key={`${metric.label}-${metric.value}`}
            className="min-w-0 bg-[var(--surface-base)] px-3 py-2.5"
          >
            <div className={`text-title-small tabular-nums ${tone.text}`}>
              {metric.value}
            </div>
            <div className="mt-0.5 truncate text-body-small-default text-[var(--content-secondary)]">
              {metric.label}
            </div>
            {metric.detail && (
              <div className="mt-1 truncate text-body-small-default text-[var(--content-tertiary)]">
                {metric.detail}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MetadataRow({ metadata }: { metadata: WorkResultMetadata[] }) {
  if (metadata.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {metadata.map((meta) => (
        <span
          key={`${meta.label}-${meta.value}`}
          className="rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]"
        >
          {meta.label}:{" "}
          <span className="text-[var(--content-secondary)]">{meta.value}</span>
        </span>
      ))}
    </div>
  );
}

function ItemList({ items }: { items: WorkResultItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3 divide-y divide-[var(--border-base)]">
      {items.map((item) => {
        const tone = toneClasses(item.tone);
        return (
        <div
          key={item.id ?? item.title}
          className="flex gap-3 py-2.5 first:pt-0 last:pb-0"
        >
          <span
            aria-hidden
            className={`w-[3px] shrink-0 self-stretch rounded-full ${tone.rail}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start gap-2">
              <span className="min-w-0 flex-1 text-body-medium-default text-[var(--content-strong)]">
                {item.title}
              </span>
              {item.status && (
                <span className="shrink-0 rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-label-small-default text-[var(--content-secondary)]">
                  {item.status}
                </span>
              )}
              {item.href && (
                <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" />
              )}
            </div>
            {item.description && (
              <p className="mt-0.5 text-body-small-default text-[var(--content-quiet)]">
                {item.description}
              </p>
            )}
            <MetadataRow metadata={item.metadata ?? []} />
          </div>
        </div>
        );
      })}
    </div>
  );
}

function DiffBlock({ diffs }: { diffs: WorkResultDiff[] }) {
  if (diffs.length === 0) return null;
  return (
    <div className="mt-3 space-y-3">
      {diffs.map((diff, index) => (
        <div key={`${diff.label ?? "diff"}-${index}`}>
          {diff.label && (
            <div className="mb-1 text-label-medium-default text-[var(--content-secondary)]">
              {diff.label}
            </div>
          )}
          <div className="grid gap-px overflow-hidden rounded-md border border-[var(--border-base)] bg-[var(--border-base)] sm:grid-cols-[1fr_auto_1fr]">
            <div className="min-w-0 bg-[var(--surface-base)] p-3">
              <div className="mb-1 text-label-small-default text-[var(--content-tertiary)]">
                Before
              </div>
              <p className="whitespace-pre-wrap text-body-small-default text-[var(--content-secondary)]">
                {diff.before ?? "Not set"}
              </p>
            </div>
            <div className="hidden items-center bg-[var(--surface-base)] px-2 text-[var(--content-tertiary)] sm:flex">
              <ArrowRight className="h-4 w-4" />
            </div>
            <div className="min-w-0 bg-[var(--surface-base)] p-3">
              <div className="mb-1 text-label-small-default text-[var(--content-tertiary)]">
                After
              </div>
              <p className="whitespace-pre-wrap text-body-small-default text-[var(--content-strong)]">
                {diff.after ?? "Removed"}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionIcon({ type }: { type: WorkResultSectionType }) {
  const Icon =
    type === "warnings"
      ? CircleAlert
      : type === "artifacts"
        ? FileText
        : type === "diff"
          ? ArrowLeftRight
          : type === "timeline"
            ? Clock3
            : ListChecks;
  // The section header carries the type marker exactly once. Items below use a
  // tone rail instead of icons, so nothing is repeated. Only "attention"
  // sections get a tone color; everything else stays monochrome.
  const color =
    type === "warnings"
      ? "text-[var(--system-mid-strong)]"
      : "text-[var(--content-tertiary)]";
  return <Icon className={`h-4 w-4 shrink-0 ${color}`} aria-hidden />;
}

function ResultSection({ section }: { section: WorkResultSection }) {
  const type = section.type ?? "items";
  const count =
    type === "diff"
      ? (section.diffs?.length ?? 0)
      : (section.items?.length ?? 0);
  return (
    <section className="border-t border-[var(--border-base)] pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <SectionIcon type={type} />
        <h4 className="text-title-small text-[var(--content-strong)]">
          {section.title}
        </h4>
        {count > 0 && (
          <span className="rounded-full bg-[var(--surface-active)] px-1.5 py-0.5 text-label-small-default tabular-nums text-[var(--content-tertiary)]">
            {count}
          </span>
        )}
      </div>
      {section.description && (
        <p className="mt-1 text-body-small-default text-[var(--content-quiet)]">
          {section.description}
        </p>
      )}
      {type === "diff" ? (
        <DiffBlock diffs={section.diffs ?? []} />
      ) : (
        <ItemList items={section.items ?? []} />
      )}
    </section>
  );
}

export function WorkResultSurface({
  surface,
  onAction,
}: WorkResultSurfaceProps) {
  const data = parseData(surface.data);
  const title = surface.title || "Work completed";
  const sections = data.sections ?? [];
  const surfaceWithoutContainerTitle = { ...surface, title: undefined };

  return (
    <SurfaceContainer
      surface={surfaceWithoutContainerTitle}
      onAction={onAction}
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {data.eyebrow && (
              <div className="mb-1 text-label-small-default uppercase text-[var(--content-tertiary)]">
                {data.eyebrow}
              </div>
            )}
            <h3 className="text-title-medium text-[var(--content-strong)]">
              {title}
            </h3>
            {data.summary && (
              <p className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]">
                {data.summary}
              </p>
            )}
          </div>
          <ResultStatusBadge status={data.status} />
        </div>

        <MetricGrid metrics={data.metrics ?? []} />

        {sections.length > 0 && (
          <div className="mt-5 space-y-4">
            {sections.map((section) => (
              <ResultSection
                key={section.id ?? section.title}
                section={section}
              />
            ))}
          </div>
        )}
      </div>
    </SurfaceContainer>
  );
}
