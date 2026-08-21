import {
  type WorkResultDiff,
  type WorkResultItem,
  type WorkResultMetadata,
  type WorkResultMetric,
  type WorkResultSection,
  type WorkResultSectionType,
  type WorkResultStatus,
  type WorkResultSurfaceData,
  WorkResultSurfaceDataSchema,
  type WorkResultTone,
} from "@vellumai/assistant-api";
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  FileText,
  ListChecks,
  OctagonX,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";

import { useTranslation } from "@/i18n";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { cn } from "@/utils/misc";
import { handleNativeAnchorClick } from "@/utils/native-anchor";
import { isRelayableExternalHref } from "@/utils/sandbox-bridge";

/**
 * Where an item's `href` points. An `app` link is a path inside this client
 * (`/assistant/skills/linear?tab=history`) and navigates in place; an
 * `external` link (http(s), mailto, tel) opens outside the conversation.
 * A view-side classification of the wire's `href`, not a wire field.
 */
interface WorkResultItemLink {
  href: string;
  kind: "app" | "external";
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

/**
 * The canonical schema is tolerant: a field the model got wrong parses to
 * `""` / `undefined` rather than failing the payload. Blank text is dropped
 * at render so a coerced-empty title or label never becomes an empty row.
 */
function hasText(value: string | number | undefined): boolean {
  return typeof value === "number" || (value ?? "").trim().length > 0;
}

/**
 * Base only used to resolve a candidate in-app path the way an anchor would;
 * a `.invalid` host so the value can never coincide with a real origin.
 */
const APP_PATH_PROBE_ORIGIN = "https://work-result-item.invalid";

/**
 * Whether `href` stays on this origin when the browser resolves it as an
 * anchor target. Resolving is the check, not a prefix test, because a
 * middle-click or copy-link reads the raw attribute: `//host/x`, the spec's
 * backslash form `/\host/x`, and `/<tab>/host/x` (the parser strips tabs and
 * newlines before it looks for an authority) all leave the origin, and every
 * other normalization the parser applies is covered the same way.
 */
function isAppRelativePath(href: string): boolean {
  if (!href.startsWith("/")) {
    return false;
  }
  try {
    return (
      new URL(href, APP_PATH_PROBE_ORIGIN).origin === APP_PATH_PROBE_ORIGIN
    );
  } catch {
    // The parser rejected it (e.g. `//[` has an invalid host), which is the
    // verdict itself: something a browser cannot resolve is not a link.
    return false;
  }
}

/**
 * Narrow an item's `href` to a link the card will follow. Only in-app paths
 * and the external schemes the host opens for sandboxed frames qualify: the
 * model authors this field, so anything else (`javascript:`, protocol-relative
 * `//host`, bare words) renders as plain text rather than becoming a
 * clickable target.
 */
export function parseItemLink(
  value: string | undefined,
): WorkResultItemLink | undefined {
  const href = value?.trim();
  if (!href) {
    return undefined;
  }
  if (isAppRelativePath(href)) {
    return { href, kind: "app" };
  }
  if (isRelayableExternalHref(href)) {
    return { href, kind: "external" };
  }
  return undefined;
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
  if (!status) {
    return null;
  }
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
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-label-small-default",
        tone.bg,
        tone.text,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </span>
  );
}

function MetricGrid({ metrics }: { metrics: WorkResultMetric[] }) {
  if (metrics.length === 0) {
    return null;
  }
  return (
    <div className="mt-4 grid gap-px overflow-hidden rounded-md border border-[var(--border-base)] bg-[var(--border-base)] sm:grid-cols-3">
      {metrics.map((metric, index) => {
        const tone = toneClasses(metric.tone);
        return (
          <div
            key={`${metric.label}-${index}`}
            className="min-w-0 bg-[var(--surface-base)] px-3 py-2.5"
          >
            <div className={cn("text-title-small tabular-nums", tone.text)}>
              {metric.value}
            </div>
            <div className="mt-0.5 truncate text-body-small-default text-[var(--content-secondary)]">
              {metric.label}
            </div>
            {hasText(metric.detail) && (
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
  const shown = metadata.filter((meta) => hasText(meta.label));
  if (shown.length === 0) {
    return null;
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {shown.map((meta, index) => (
        <span
          key={`${meta.label}-${index}`}
          className="rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]"
        >
          {meta.label}:{" "}
          <span className="text-[var(--content-secondary)]">{meta.value}</span>
        </span>
      ))}
    </div>
  );
}

const ITEM_ROW_CLASS = "flex gap-3 py-2.5 first:pt-0 last:pb-0";
const LINKED_ITEM_ROW_CLASS = cn(
  ITEM_ROW_CLASS,
  "-mx-2 rounded-md px-2 transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
);

/**
 * The row element for one item. A linked item is the whole row as one anchor
 * (matching the clickable-row pattern in skill-created-card.tsx): an in-app
 * path is a router `Link` so it navigates in place; an external URL opens
 * outside the conversation, routed through the native opener on iOS where a
 * `target="_blank"` anchor silently no-ops. An unlinked item is a plain row.
 */
function ItemRow({
  link,
  children,
}: {
  link: WorkResultItemLink | undefined;
  children: ReactNode;
}) {
  if (!link) {
    return <div className={ITEM_ROW_CLASS}>{children}</div>;
  }
  if (link.kind === "app") {
    return (
      <Link to={link.href} className={LINKED_ITEM_ROW_CLASS}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => handleNativeAnchorClick(event, link.href)}
      className={LINKED_ITEM_ROW_CLASS}
    >
      {children}
    </a>
  );
}

function ItemLinkIcon({ link }: { link: WorkResultItemLink | undefined }) {
  if (!link) {
    return null;
  }
  const Icon = link.kind === "external" ? ExternalLink : ChevronRight;
  return (
    <Icon
      aria-hidden
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
    />
  );
}

function ItemList({ items }: { items: WorkResultItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 divide-y divide-[var(--border-base)]">
      {items.map((item, index) => {
        const tone = toneClasses(item.tone);
        const link = parseItemLink(item.href);
        return (
          <ItemRow key={item.id ?? `${index}`} link={link}>
            <span
              aria-hidden
              className={cn(
                "w-[3px] shrink-0 self-stretch rounded-full",
                tone.rail,
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-start gap-2">
                <span className="min-w-0 flex-1 text-body-medium-default text-[var(--content-strong)]">
                  {item.title}
                </span>
                {hasText(item.status) && (
                  <span className="shrink-0 rounded-full bg-[var(--surface-active)] px-2 py-0.5 text-label-small-default text-[var(--content-secondary)]">
                    {item.status}
                  </span>
                )}
                <ItemLinkIcon link={link} />
              </div>
              {hasText(item.description) && (
                <p className="mt-0.5 text-body-small-default text-[var(--content-quiet)]">
                  {item.description}
                </p>
              )}
              <MetadataRow metadata={item.metadata ?? []} />
            </div>
          </ItemRow>
        );
      })}
    </div>
  );
}

function DiffBlock({ diffs }: { diffs: WorkResultDiff[] }) {
  const { t } = useTranslation("chat");
  if (diffs.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 space-y-3">
      {diffs.map((diff, index) => (
        <div key={`${diff.label ?? "diff"}-${index}`}>
          {hasText(diff.label) && (
            <div className="mb-1 text-label-medium-default text-[var(--content-secondary)]">
              {diff.label}
            </div>
          )}
          <div className="grid gap-px overflow-hidden rounded-md border border-[var(--border-base)] bg-[var(--border-base)] sm:grid-cols-[1fr_auto_1fr]">
            <div className="min-w-0 bg-[var(--surface-base)] p-3">
              <div className="mb-1 text-label-small-default text-[var(--content-tertiary)]">
                {t("workResultSurface.before")}
              </div>
              <p className="whitespace-pre-wrap text-body-small-default text-[var(--content-secondary)]">
                {hasText(diff.before) ? diff.before : t("workResultSurface.notSet")}
              </p>
            </div>
            <div className="hidden items-center bg-[var(--surface-base)] px-2 text-[var(--content-tertiary)] sm:flex">
              <ArrowRight className="h-4 w-4" />
            </div>
            <div className="min-w-0 bg-[var(--surface-base)] p-3">
              <div className="mb-1 text-label-small-default text-[var(--content-tertiary)]">
                {t("workResultSurface.after")}
              </div>
              <p className="whitespace-pre-wrap text-body-small-default text-[var(--content-strong)]">
                {hasText(diff.after) ? diff.after : t("workResultSurface.removed")}
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
  return <Icon className={cn("h-4 w-4 shrink-0", color)} aria-hidden />;
}

function ResultSection({ section }: { section: WorkResultSection }) {
  const type = section.type ?? "items";
  const items = (section.items ?? []).filter((item) => hasText(item.title));
  const diffs = (section.diffs ?? []).filter(
    (diff) => hasText(diff.before) || hasText(diff.after),
  );
  const count = type === "diff" ? diffs.length : items.length;
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
      {hasText(section.description) && (
        <p className="mt-1 text-body-small-default text-[var(--content-quiet)]">
          {section.description}
        </p>
      )}
      {type === "diff" ? (
        <DiffBlock diffs={diffs} />
      ) : (
        <ItemList items={items} />
      )}
    </section>
  );
}

export function WorkResultSurface({
  surface,
  onAction,
}: WorkResultSurfaceProps) {
  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (tolerant, so a real payload never fails to parse) rather than an
  // unchecked cast or a re-declared local interface.
  const data = useMemo<WorkResultSurfaceData>(() => {
    const parsed = WorkResultSurfaceDataSchema.safeParse(surface.data);
    return parsed.success ? parsed.data : {};
  }, [surface.data]);
  const title = surface.title || "Work completed";
  const metrics = (data.metrics ?? []).filter(
    (metric) => hasText(metric.label) && hasText(metric.value),
  );
  const sections = (data.sections ?? []).filter((section) =>
    hasText(section.title),
  );
  const surfaceWithoutContainerTitle = { ...surface, title: undefined };

  return (
    <SurfaceContainer
      surface={surfaceWithoutContainerTitle}
      onAction={onAction}
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {hasText(data.eyebrow) && (
              <div className="mb-1 text-label-small-default uppercase text-[var(--content-tertiary)]">
                {data.eyebrow}
              </div>
            )}
            <h3 className="text-title-medium text-[var(--content-strong)]">
              {title}
            </h3>
            {hasText(data.summary) && (
              <p className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]">
                {data.summary}
              </p>
            )}
          </div>
          <ResultStatusBadge status={data.status} />
        </div>

        <MetricGrid metrics={metrics} />

        {sections.length > 0 && (
          <div className="mt-5 space-y-4">
            {sections.map((section, index) => (
              <ResultSection key={section.id ?? `${index}`} section={section} />
            ))}
          </div>
        )}
      </div>
    </SurfaceContainer>
  );
}
