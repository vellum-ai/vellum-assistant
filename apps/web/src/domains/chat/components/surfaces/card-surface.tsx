
import { Circle, CircleCheck, CircleX, Clock, Loader2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import type { Surface } from "@/domains/chat/types/types.js";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message.js";
import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container.js";
import { WeatherForecastDisplay } from "@/domains/chat/components/surfaces/weather-forecast-display.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CardMetadataItem {
  label: string;
  value: string;
}

interface TaskStepItem {
  id: string;
  label: string;
  status?: string;
  detail?: string;
}

interface CardSurfaceData {
  title: string;
  subtitle?: string;
  body: string;
  metadata?: CardMetadataItem[];
  template?: string;
  templateData?: Record<string, unknown>;
}

interface CardSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Task progress helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, { label: string; colorClass: string }> = {
  completed: { label: "Completed", colorClass: "text-[var(--system-positive-strong)]" },
  in_progress: { label: "In Progress", colorClass: "text-[var(--system-mid-strong)]" },
  waiting: { label: "Waiting", colorClass: "text-[var(--system-mid-strong)]" },
  failed: { label: "Failed", colorClass: "text-[var(--system-negative-strong)]" },
};

const DEFAULT_STATUS = { label: "Pending", colorClass: "text-[var(--content-disabled)]" };

function getStatusConfig(status: string | undefined) {
  return STATUS_CONFIG[status ?? ""] ?? DEFAULT_STATUS;
}

function StatusBadge({ status }: { status: string | undefined }) {
  const { label, colorClass } = getStatusConfig(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-body-small-default ${colorClass}`}
      style={{ backgroundColor: "color-mix(in srgb, currentColor 15%, transparent)" }}
    >
      {label}
    </span>
  );
}

function StepIcon({ status }: { status: string | undefined }) {
  const { colorClass } = getStatusConfig(status);
  const iconClass = `h-4 w-4 shrink-0 ${colorClass}`;

  switch (status) {
    case "completed":
      return <CircleCheck className={iconClass} />;
    case "in_progress":
      return <Loader2 className={`${iconClass} animate-spin`} />;
    case "waiting":
      return <Clock className={iconClass} />;
    case "failed":
      return <CircleX className={iconClass} />;
    default:
      return <Circle className={iconClass} />;
  }
}

// ---------------------------------------------------------------------------
// Task progress template
// ---------------------------------------------------------------------------

function TaskProgressBar({ templateData }: { templateData: Record<string, unknown> }) {
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
      <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-moss-600">
        <div
          className="h-full rounded-full bg-forest-500 transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function InProgressDetail({ value }: { value: string }) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <div className="relative h-3 min-w-0 max-w-[50%] overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={prefersReducedMotion ? false : { y: "-100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { y: "100%", opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="block truncate text-body-small-default text-[var(--content-tertiary)]"
          title={value}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

function TaskStepList({ steps }: { steps: TaskStepItem[] }) {
  return (
    <div className="mt-5 divide-y divide-[var(--border-base)]">
      {steps.map((step, index) => {
        const showDetailOnRight = step.status === "in_progress" && !!step.detail;
        return (
          <div key={step.id || index} className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
            <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-stone-100 px-1.5 text-label-medium-default tabular-nums text-[var(--content-tertiary)] dark:bg-moss-600">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <span className="text-body-medium-default text-[var(--content-strong)]">
                {step.label}
              </span>
              {step.detail && !showDetailOnRight && (
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {step.detail}
                </p>
              )}
            </div>
            {showDetailOnRight && <InProgressDetail value={step.detail!} />}
            <div className="shrink-0">
              <StepIcon status={step.status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskProgressDisplay({ templateData }: { templateData: Record<string, unknown> }) {
  const steps = Array.isArray(templateData.steps)
    ? (templateData.steps as TaskStepItem[])
    : null;

  if (steps && steps.length > 0) {
    const title = typeof templateData.title === "string" ? templateData.title : "Task";
    const status = typeof templateData.status === "string" ? templateData.status : undefined;

    return (
      <div>
        <div className="flex items-center justify-between">
          <span className="text-title-small text-[var(--content-strong)]">{title}</span>
          <StatusBadge status={status} />
        </div>
        <TaskStepList steps={steps} />
      </div>
    );
  }

  return <TaskProgressBar templateData={templateData} />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CardSurface({ surface, onAction }: CardSurfaceProps) {
  const data = surface.data as unknown as CardSurfaceData;
  const isWeather = data.template === "weather_forecast" && data.templateData;
  const isTaskProgress = data.template === "task_progress" && data.templateData;
  const hasSteps = isTaskProgress && Array.isArray(data.templateData?.steps) &&
    (data.templateData!.steps as unknown[]).length > 0;

  if (hasSteps) {
    return (
      <SurfaceContainer surface={surface} onAction={onAction}>
        <TaskProgressDisplay templateData={data.templateData!} />
      </SurfaceContainer>
    );
  }

  return (
    <SurfaceContainer surface={surface} onAction={onAction}>
      <div>
        <h3 className="text-title-small text-[var(--content-strong)]">{data.title}</h3>

        {data.subtitle && (
          <p className="mt-0.5 text-body-small-default text-[var(--content-quiet)]">{data.subtitle}</p>
        )}

        {isWeather ? (
          <WeatherForecastDisplay templateData={data.templateData!} fallback={
            <ChatMarkdownMessage
              content={data.body}
              className="mt-2 text-body-medium-lighter text-stone-600 dark:text-stone-300"
            />
          } />
        ) : (
          <>
            <ChatMarkdownMessage
              content={data.body}
              className="mt-2 text-body-medium-lighter text-stone-600 dark:text-stone-300"
            />

            {data.metadata && data.metadata.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {data.metadata.map((item) => (
                  <div key={item.label}>
                    <dt className="text-body-small-default text-[var(--content-quiet)]">
                      {item.label}
                    </dt>
                    <dd className="text-body-medium-lighter text-[var(--content-strong)]">{item.value}</dd>
                  </div>
                ))}
              </div>
            )}

            {isTaskProgress && (
              <TaskProgressDisplay templateData={data.templateData!} />
            )}
          </>
        )}
      </div>
    </SurfaceContainer>
  );
}
