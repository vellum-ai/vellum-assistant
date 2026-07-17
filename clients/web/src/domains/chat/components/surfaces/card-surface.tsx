import { lazy, type ReactNode } from "react";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
} from "lucide-react";

import { CardSurfaceDataSchema } from "@vellumai/assistant-api";
import type { Surface } from "@/domains/chat/types/types";

import { LazyBoundary } from "@/components/lazy-boundary";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";
import { cn } from "@/utils/misc";

// Weather card has its own data-shape parsing and forecast UI that is only
// rendered when a card surface advertises a weather template. Defer loading
// to keep it out of the chat-critical bundle.
const WeatherForecastDisplay = lazy(() =>
  import("@/domains/chat/components/surfaces/weather-forecast-display").then(
    (m) => ({ default: m.WeatherForecastDisplay }),
  ),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskStepItem {
  id?: string;
  label: string;
  status?: string;
  detail?: string;
}

interface CardSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Task progress helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, { label: string; colorClass: string }> = {
  completed: {
    label: "Completed",
    colorClass: "text-[var(--system-positive-strong)]",
  },
  in_progress: {
    label: "In Progress",
    colorClass: "text-[var(--system-mid-strong)]",
  },
  waiting: { label: "Waiting", colorClass: "text-[var(--system-mid-strong)]" },
  failed: {
    label: "Failed",
    colorClass: "text-[var(--system-negative-strong)]",
  },
};

const DEFAULT_STATUS = {
  label: "Pending",
  colorClass: "text-[var(--content-disabled)]",
};

function getStatusConfig(status: string | undefined) {
  return STATUS_CONFIG[status ?? ""] ?? DEFAULT_STATUS;
}

// Once the overall task is `completed`, no step should still read as unfinished:
// a model can mark the card done while leaving a step `in_progress` (a spinner),
// `waiting`, `pending`, or `failed` with no corrective per-step update, which
// would otherwise show a perpetual spinner or red glyph under a "Completed"
// header. The card's own `completed` status is the model's terminal assertion,
// so any lingering step resolves to `completed`.
function effectiveStepStatus(
  stepStatus: string | undefined,
  taskCompleted: boolean,
): string | undefined {
  if (taskCompleted && stepStatus !== "completed") {
    return "completed";
  }
  return stepStatus;
}

function normalizedTitle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Status glyph shown left of the task title: a green check-in-circle for
 * completed, a red exclamation-in-circle for failed, and a spinner while in
 * progress. Pending/waiting render no glyph — a bare title reads cleaner
 * than a placeholder circle. A visually hidden label keeps the status
 * available to assistive tech.
 */
function TitleStatusIcon({ status }: { status: string | undefined }) {
  const { label, colorClass } = getStatusConfig(status);
  const iconClass = cn("h-4 w-4 shrink-0", colorClass);

  let icon: ReactNode;
  switch (status) {
    case "completed":
      icon = <CircleCheck aria-hidden className={iconClass} />;
      break;
    case "failed":
      icon = <CircleAlert aria-hidden className={iconClass} />;
      break;
    case "in_progress":
      icon = <Loader2 aria-hidden className={cn(iconClass, "animate-spin")} />;
      break;
    default:
      return null;
  }

  return (
    <>
      {icon}
      <span className="sr-only">{label}</span>
    </>
  );
}

function StepIcon({ status }: { status: string | undefined }) {
  const { label, colorClass } = getStatusConfig(status);
  const iconClass = cn("h-4 w-4 shrink-0", colorClass);

  let icon: ReactNode;
  switch (status) {
    case "completed":
      icon = <CircleCheck aria-hidden className={iconClass} />;
      break;
    case "in_progress":
      icon = <Loader2 aria-hidden className={cn(iconClass, "animate-spin")} />;
      break;
    case "waiting":
      icon = <Clock aria-hidden className={iconClass} />;
      break;
    case "failed":
      icon = <CircleX aria-hidden className={iconClass} />;
      break;
    default:
      icon = <Circle aria-hidden className={iconClass} />;
  }

  return (
    <>
      {icon}
      <span className="sr-only">{label}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Task progress template
// ---------------------------------------------------------------------------

/**
 * The counter-style task_progress fallback only makes sense when the template
 * data actually carries usable `{ completed, total }` counters. Malformed
 * template data — e.g. a model emitting `steps` as an object instead of an
 * array, which fails `isTaskProgressSurface` — must not fall through to a
 * meaningless "0 / 0 tasks · 0%" bar; the card degrades to its plain body
 * instead. `completed` may be absent (treated as 0 by the bar), `total` must
 * coerce to a finite positive number.
 */
function hasUsableProgressCounters(
  templateData: Record<string, unknown>,
): boolean {
  const completed = Number(templateData.completed ?? 0);
  const total = Number(templateData.total ?? NaN);
  return Number.isFinite(completed) && Number.isFinite(total) && total > 0;
}

function TaskProgressBar({
  templateData,
}: {
  templateData: Record<string, unknown>;
}) {
  const completed = Number(templateData.completed ?? 0);
  const total = Number(templateData.total ?? 0);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-body-small-default text-[var(--content-quiet)]">
        <span>
          {completed} / {total} tasks
        </span>
        <span>{percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--border-subtle)]">
        <div
          className="h-full rounded-full bg-[var(--primary-base)] transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function TaskStepList({
  steps,
  taskCompleted,
}: {
  steps: TaskStepItem[];
  taskCompleted: boolean;
}) {
  return (
    <div className="mt-5 divide-y divide-[var(--border-base)]">
      {steps.map((step, index) => {
        const status = effectiveStepStatus(step.status, taskCompleted);
        const showDetailOnRight = status === "in_progress" && !!step.detail;
        return (
          // The number badge and status icon center against the *title
          // line*, not the label+detail block — the detail lives outside the
          // `items-center` row, indented past the 24px badge + 10px gap.
          <div key={step.id || index} className="py-2 first:pt-0 last:pb-0">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-[var(--tag-bg-neutral)] px-1.5 text-label-medium-default tabular-nums text-[var(--content-tertiary)]">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                {/* `block` so the label's own 18px token line-height governs
                  wrapped lines instead of the parent block's taller strut. */}
                <span className="block text-body-medium-default text-[var(--content-strong)]">
                  {step.label}
                </span>
              </div>
              {showDetailOnRight && (
                <div className="h-4 min-w-0 max-w-[50%] overflow-hidden">
                  <span
                    className="block truncate text-body-small-default leading-[16px] text-[var(--content-tertiary)]"
                    title={step.detail!}
                  >
                    {step.detail}
                  </span>
                </div>
              )}
              <div className="shrink-0">
                <StepIcon status={status} />
              </div>
            </div>
            {step.detail && !showDetailOnRight && (
              <p className="pl-[34px] text-body-small-default text-[var(--content-tertiary)]">
                {step.detail}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CardSurface({ surface, onAction }: CardSurfaceProps) {
  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (every field optional, so a real card never fails to parse) rather than an
  // unchecked cast or a re-declared local interface.
  const parsed = CardSurfaceDataSchema.safeParse(surface.data);
  const data = parsed.success ? parsed.data : {};

  const isWeather = data.template === "weather_forecast" && data.templateData;
  const isTaskProgress =
    data.template === "task_progress" &&
    !!data.templateData &&
    hasUsableProgressCounters(data.templateData);
  const steps = data.templateData?.steps;
  const hasSteps =
    data.template === "task_progress" &&
    Array.isArray(steps) &&
    steps.length > 0;
  const cardTitle =
    normalizedTitle(data.title) || normalizedTitle(surface.title);

  if (hasSteps) {
    const templateData = data.templateData!;
    const title = normalizedTitle(templateData.title) || cardTitle || "Task";
    const status =
      typeof templateData.status === "string" ? templateData.status : undefined;
    const steps = templateData.steps as TaskStepItem[];

    return (
      // `max-md:mb-2` adds breathing room below the task card before the
      // next transcript block on mobile; stacks on the transcript column's
      // `gap-2`.
      <SurfaceContainer
        surface={surface}
        onAction={onAction}
        hideTitle
        className="max-md:mb-2"
      >
        <div>
          <div className="flex items-center gap-2">
            <TitleStatusIcon status={status} />
            <span className="text-title-small text-[var(--content-strong)]">
              {title}
            </span>
          </div>
          <TaskStepList steps={steps} taskCompleted={status === "completed"} />
        </div>
      </SurfaceContainer>
    );
  }

  const bodyMarkdown = (
    <ChatMarkdownMessage
      content={data.body ?? ""}
      className="mt-2 text-body-medium-lighter text-[var(--content-tertiary)]"
    />
  );

  return (
    <SurfaceContainer surface={surface} onAction={onAction} hideTitle>
      <div>
        {cardTitle && (
          <h3 className="text-title-small text-[var(--content-strong)]">
            {cardTitle}
          </h3>
        )}

        {data.subtitle && (
          <p className="mt-0.5 text-body-small-default text-[var(--content-quiet)]">
            {data.subtitle}
          </p>
        )}

        {isWeather ? (
          <LazyBoundary fallback={bodyMarkdown} errorFallback={bodyMarkdown}>
            <WeatherForecastDisplay
              templateData={data.templateData!}
              fallback={bodyMarkdown}
            />
          </LazyBoundary>
        ) : (
          <>
            {bodyMarkdown}

            {data.metadata && data.metadata.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {data.metadata.map((item) => (
                  <div key={item.label}>
                    <dt className="text-body-small-default text-[var(--content-quiet)]">
                      {item.label}
                    </dt>
                    <dd className="text-body-medium-lighter text-[var(--content-strong)]">
                      {item.value}
                    </dd>
                  </div>
                ))}
              </div>
            )}

            {isTaskProgress && (
              <TaskProgressBar templateData={data.templateData!} />
            )}
          </>
        )}
      </div>
    </SurfaceContainer>
  );
}
