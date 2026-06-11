import { Clock } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import {
  createSchedule,
  type CreateSchedulePayload,
} from "@/domains/settings/api/schedules";
import {
  buildCronExpression,
  type Cadence,
  describeCadence,
  DEFAULT_CADENCE,
  formatOrdinal,
  type ScheduleFrequency,
  WEEKDAYS,
} from "@/domains/settings/utils/cron-builder";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";
import { cn } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import {
  Dropdown,
  type DropdownOption,
} from "@vellumai/design-library/components/dropdown";
import { Input, Textarea } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import {
  SegmentControl,
  type SegmentControlItem,
} from "@vellumai/design-library/components/segment-control";

// ---------------------------------------------------------------------------
// Static option lists for the cadence builder
// ---------------------------------------------------------------------------

const FREQUENCY_ITEMS: SegmentControlItem<ScheduleFrequency>[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const HOUR12_OPTIONS: DropdownOption<string>[] = Array.from(
  { length: 12 },
  (_, i) => {
    const hour = i + 1;
    return { value: String(hour), label: String(hour) };
  },
);

// Five-minute granularity keeps the menu short while covering the times people
// actually schedule.
const MINUTE_OPTIONS: DropdownOption<string>[] = Array.from(
  { length: 12 },
  (_, i) => {
    const minute = i * 5;
    const padded = String(minute).padStart(2, "0");
    return { value: padded, label: padded };
  },
);

// Only days that exist in every month (1–28) plus an explicit "Last day", so a
// monthly schedule never silently skips short months. The 29th–31st (which skip
// February etc.) remain available through the Advanced cron field.
const DAY_OF_MONTH_OPTIONS: DropdownOption<string>[] = [
  ...Array.from({ length: 28 }, (_, i) => {
    const day = i + 1;
    return { value: String(day), label: formatOrdinal(day) };
  }),
  { value: "last", label: "Last day" },
];

const PERIOD_ITEMS: SegmentControlItem<"AM" | "PM">[] = [
  { value: "AM", label: "AM" },
  { value: "PM", label: "PM" },
];

function to24Hour(hour12: number, period: "AM" | "PM"): number {
  const base = hour12 % 12;
  return period === "PM" ? base + 12 : base;
}

/** Friendly timezone label, e.g. "America/New_York · EDT". */
function describeTimezone(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const abbreviation = parts.find(
      (part) => part.type === "timeZoneName",
    )?.value;
    return abbreviation && abbreviation !== timezone
      ? `${timezone} · ${abbreviation}`
      : timezone;
  } catch {
    return timezone;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CreateScheduleModalProps {
  isOpen: boolean;
  assistantId: string;
  onClose: () => void;
  onCreated: () => void;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function CreateScheduleModal({
  isOpen,
  assistantId,
  onClose,
  onCreated,
}: CreateScheduleModalProps) {
  return (
    <Modal.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {isOpen ? (
        <CreateScheduleModalInner
          assistantId={assistantId}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : null}
    </Modal.Root>
  );
}

function CreateScheduleModalInner({
  assistantId,
  onClose,
  onCreated,
}: {
  assistantId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const timezone = useEffectiveTimezone();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [cadence, setCadence] = useState<Cadence>(DEFAULT_CADENCE);
  const [rawExpression, setRawExpression] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const trimmedMessage = message.trim();
  const trimmedRaw = rawExpression.trim();

  const expression = useMemo(
    () => (mode === "simple" ? buildCronExpression(cadence) : trimmedRaw),
    [mode, cadence, trimmedRaw],
  );

  const summary = useMemo(() => {
    if (mode === "simple") return describeCadence(cadence);
    return trimmedRaw ? trimmedRaw : "Enter a cron expression to continue.";
  }, [mode, cadence, trimmedRaw]);

  const timezoneLabel = useMemo(() => describeTimezone(timezone), [timezone]);

  const canSubmit =
    trimmedName.length > 0 &&
    trimmedDescription.length > 0 &&
    trimmedMessage.length > 0 &&
    expression.length > 0 &&
    !submitting;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload: CreateSchedulePayload = {
        name: trimmedName,
        description: trimmedDescription,
        expression,
        message: trimmedMessage,
        // Schedules always run in the user's current timezone — inferred here
        // rather than asked for, so the time the user picked means what they
        // expect.
        timezone,
      };
      await createSchedule(assistantId, payload);
      setSubmitting(false);
      onCreated();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create schedule.",
      );
      setSubmitting(false);
    }
  };

  const switchToAdvanced = () => {
    // Seed the raw field with the equivalent cron so power users start from
    // what they had configured rather than a blank box.
    setRawExpression((prev) => prev || buildCronExpression(cadence));
    setMode("advanced");
  };

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>Create schedule</Modal.Title>
        <Modal.Description>
          Schedule a recurring instruction for your assistant. Runs in execute
          mode — the message is delivered to the assistant on each fire.
        </Modal.Description>
      </Modal.Header>

      <form onSubmit={onSubmit}>
        <Modal.Body>
          <div className="flex flex-col gap-5">
            <Input
              label="Name"
              placeholder="Morning briefing"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              fullWidth
            />

            <Textarea
              label="Description"
              placeholder="What is this schedule for?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              fullWidth
              rows={2}
            />

            <Field label="Repeat">
              {mode === "simple" ? (
                <CadenceBuilder cadence={cadence} onChange={setCadence} />
              ) : (
                <AdvancedCron
                  value={rawExpression}
                  onChange={setRawExpression}
                  onUseSimple={() => setMode("simple")}
                />
              )}
            </Field>

            <ScheduleSummary
              summary={summary}
              mono={mode === "advanced" && trimmedRaw.length > 0}
              timezoneLabel={timezoneLabel}
            />

            {mode === "simple" ? (
              <button
                type="button"
                onClick={switchToAdvanced}
                className="self-start text-body-small-default text-[var(--content-tertiary)] underline-offset-2 transition-colors hover:text-[var(--content-default)] hover:underline"
              >
                Advanced — write a cron expression
              </button>
            ) : null}

            <Textarea
              label="Message"
              placeholder="What should the assistant do on each fire?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              fullWidth
              rows={4}
            />

            {submitError ? (
              <p className="text-body-small-default text-[var(--system-negative-strong)]">
                {submitError}
              </p>
            ) : null}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="outlined" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create schedule"}
          </Button>
        </Modal.Footer>
      </form>
    </Modal.Content>
  );
}

// ---------------------------------------------------------------------------
// Cadence builder (simple mode)
// ---------------------------------------------------------------------------

function CadenceBuilder({
  cadence,
  onChange,
}: {
  cadence: Cadence;
  onChange: (next: Cadence) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SegmentControl
        items={FREQUENCY_ITEMS}
        value={cadence.frequency}
        onChange={(frequency) => onChange({ ...cadence, frequency })}
        ariaLabel="How often the schedule runs"
      />

      {cadence.frequency === "hourly" ? (
        <SubField label="At minute">
          <Dropdown
            options={MINUTE_OPTIONS}
            value={String(cadence.minute).padStart(2, "0")}
            onChange={(value) =>
              onChange({ ...cadence, minute: Number(value) })
            }
            aria-label="Minute"
            className="w-24"
          />
        </SubField>
      ) : null}

      {cadence.frequency === "weekly" ? (
        <SubField label="On these days">
          <WeekdayPicker
            value={cadence.weekdays}
            onChange={(weekdays) => onChange({ ...cadence, weekdays })}
          />
        </SubField>
      ) : null}

      {cadence.frequency === "monthly" ? (
        <SubField label="On day">
          <Dropdown
            options={DAY_OF_MONTH_OPTIONS}
            value={cadence.dayOfMonth === "last" ? "last" : String(cadence.dayOfMonth)}
            onChange={(value) =>
              onChange({
                ...cadence,
                dayOfMonth: value === "last" ? "last" : Number(value),
              })
            }
            aria-label="Day of month"
            className="w-32"
          />
        </SubField>
      ) : null}

      {cadence.frequency !== "hourly" ? (
        <SubField label="At time">
          <TimeFields
            hour24={cadence.hour24}
            minute={cadence.minute}
            onChange={(hour24, minute) =>
              onChange({ ...cadence, hour24, minute })
            }
          />
        </SubField>
      ) : null}
    </div>
  );
}

function TimeFields({
  hour24,
  minute,
  onChange,
}: {
  hour24: number;
  minute: number;
  onChange: (hour24: number, minute: number) => void;
}) {
  const period: "AM" | "PM" = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return (
    <div className="flex items-center gap-2">
      <Dropdown
        options={HOUR12_OPTIONS}
        value={String(hour12)}
        onChange={(value) => onChange(to24Hour(Number(value), period), minute)}
        aria-label="Hour"
        className="w-[72px]"
      />
      <span className="text-body-medium-default text-[var(--content-tertiary)]">
        :
      </span>
      <Dropdown
        options={MINUTE_OPTIONS}
        value={String(minute).padStart(2, "0")}
        onChange={(value) => onChange(hour24, Number(value))}
        aria-label="Minute"
        className="w-[72px]"
      />
      <div className="w-[112px]">
        <SegmentControl
          items={PERIOD_ITEMS}
          value={period}
          onChange={(nextPeriod) =>
            onChange(to24Hour(hour12, nextPeriod), minute)
          }
          ariaLabel="AM or PM"
        />
      </div>
    </div>
  );
}

function WeekdayPicker({
  value,
  onChange,
}: {
  value: readonly number[];
  onChange: (next: number[]) => void;
}) {
  const selected = new Set(value);

  const toggle = (day: number) => {
    const next = new Set(selected);
    if (next.has(day)) {
      // Keep at least one day selected — an empty set can't be scheduled.
      if (next.size > 1) next.delete(day);
    } else {
      next.add(day);
    }
    onChange([...next].sort((a, b) => a - b));
  };

  return (
    <div className="flex gap-1.5">
      {WEEKDAYS.map((weekday) => {
        const isActive = selected.has(weekday.value);
        return (
          <button
            key={weekday.value}
            type="button"
            onClick={() => toggle(weekday.value)}
            aria-pressed={isActive}
            aria-label={weekday.full}
            title={weekday.full}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-md border text-body-medium-default transition-colors",
              isActive
                ? "border-[var(--border-active)] bg-[var(--surface-active)] text-[var(--content-emphasised)]"
                : "border-[var(--field-border)] text-[var(--content-tertiary)] hover:border-[var(--border-active)] hover:text-[var(--content-default)]",
            )}
          >
            {weekday.letter}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced cron mode
// ---------------------------------------------------------------------------

function AdvancedCron({
  value,
  onChange,
  onUseSimple,
}: {
  value: string;
  onChange: (next: string) => void;
  onUseSimple: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder="0 9 * * *"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        fullWidth
        className="font-mono"
        aria-label="Cron expression"
        helperText="Standard 5-field cron (minute hour day month weekday). RRULE expressions are also accepted."
      />
      <button
        type="button"
        onClick={onUseSimple}
        className="self-start text-body-small-default text-[var(--content-tertiary)] underline-offset-2 transition-colors hover:text-[var(--content-default)] hover:underline"
      >
        ← Back to the simple builder
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared presentational helpers
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-body-small-default text-[var(--content-secondary)]">
        {label}
      </span>
      {children}
    </div>
  );
}

function SubField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="min-w-[88px] text-body-small-default text-[var(--content-tertiary)]">
        {label}
      </span>
      {children}
    </div>
  );
}

function ScheduleSummary({
  summary,
  mono,
  timezoneLabel,
}: {
  summary: string;
  mono: boolean;
  timezoneLabel: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-3.5 py-3">
      <Clock
        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
        aria-hidden
      />
      <div className="min-w-0">
        <p
          className={cn(
            "text-body-medium-default text-[var(--content-default)]",
            mono && "break-all font-mono",
          )}
        >
          {summary}
        </p>
        <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
          Times use your timezone — {timezoneLabel}.
        </p>
      </div>
    </div>
  );
}
