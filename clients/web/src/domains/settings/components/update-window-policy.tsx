import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
    assistantsUpgradePolicyDetailReadOptions,
    assistantsUpgradePolicyDetailReadQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { assistantsUpgradePolicyDetailPartialUpdate } from "@/generated/api/sdk.gen";
import type {
    FrequencyEnum,
    UpgradePolicy,
} from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

const DAY_ENTRIES: ReadonlyArray<[label: string, backendIndex: number]> = [
  ["Mon", 0],
  ["Tue", 1],
  ["Wed", 2],
  ["Thu", 3],
  ["Fri", 4],
  ["Sat", 5],
  ["Sun", 6],
];

function utcTimeToLocal(utcTime: string): string {
  const [hours, minutes] = utcTime.split(":").map(Number);
  const now = new Date();
  const date = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hours,
      minutes,
    ),
  );
  const localHours = date.getHours().toString().padStart(2, "0");
  const localMinutes = date.getMinutes().toString().padStart(2, "0");
  return `${localHours}:${localMinutes}`;
}

function localTimeToUtc(localTime: string): string {
  const [hours, minutes] = localTime.split(":").map(Number);
  const now = new Date();
  const date = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
  );
  const utcHours = date.getUTCHours().toString().padStart(2, "0");
  const utcMinutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${utcHours}:${utcMinutes}`;
}

function getLocalTimezoneAbbreviation(): string {
  return (
    Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

interface FormState {
  enabled: boolean;
  timezone: string;
  frequency: FrequencyEnum;
  daysOfWeek: number[];
  daysOfMonth: number[];
  windowStart: string;
  windowEnd: string;
}

function policyToFormState(p: UpgradePolicy | undefined): FormState {
  const utcStart = p?.schedule?.window.start ?? "06:00";
  const utcEnd = p?.schedule?.window.end ?? "08:00";
  return {
    enabled: p?.enabled ?? true,
    timezone: "UTC",
    frequency: p?.schedule?.frequency ?? "weekly",
    daysOfWeek: p?.schedule?.days_of_week ?? [0],
    daysOfMonth: p?.schedule?.days_of_month ?? [],
    windowStart: utcTimeToLocal(utcStart),
    windowEnd: utcTimeToLocal(utcEnd),
  };
}

interface UpdateWindowPolicyProps {
  assistantId: string;
}

export function UpdateWindowPolicy({
  assistantId,
}: UpdateWindowPolicyProps) {
  const queryClient = useQueryClient();

  const {
    data: policy,
    isLoading: policyLoading,
    isError: policyError,
  } = useQuery(
    assistantsUpgradePolicyDetailReadOptions({
      path: { id: assistantId },
    }),
  );

  const baseForm = useMemo(() => policyToFormState(policy), [policy]);
  const [localForm, setLocalForm] = useState<FormState | null>(null);
  const form: FormState = localForm ?? baseForm;
  const dirty = localForm !== null;

  const tzAbbrev = useMemo(() => getLocalTimezoneAbbreviation(), []);

  const [daysOfMonthText, setDaysOfMonthText] = useState<string | null>(null);
  const displayDaysOfMonthText =
    daysOfMonthText ?? form.daysOfMonth.join(", ");

  const policyUpdate = useMutation({
    mutationFn: async (body: {
      enabled?: boolean;
      timezone?: string;
      schedule?: {
        frequency: FrequencyEnum;
        days_of_week: number[];
        days_of_month: number[];
        window: { start: string; end: string };
      };
    }) => {
      const { data } = await assistantsUpgradePolicyDetailPartialUpdate({
        path: { id: assistantId },
        body,
        throwOnError: true,
      });
      return data;
    },
  });

  const update = (patch: Partial<FormState>) => {
    setLocalForm((prev) => ({ ...(prev ?? baseForm), ...patch }));
  };

  const toggleDayOfWeek = (day: number) => {
    const next = form.daysOfWeek.includes(day)
      ? form.daysOfWeek.filter((d) => d !== day)
      : [...form.daysOfWeek, day].sort((a, b) => a - b);
    update({ daysOfWeek: next });
  };

  const parseDaysOfMonth = (value: string): number[] =>
    value
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= 31);

  const handleSavePolicy = async () => {
    const daysOfMonthToSave =
      form.frequency === "monthly" && daysOfMonthText !== null
        ? parseDaysOfMonth(daysOfMonthText)
        : form.daysOfMonth;

    try {
      await policyUpdate.mutateAsync({
        enabled: form.enabled,
        timezone: "UTC",
        schedule: {
          frequency: form.frequency,
          days_of_week: form.frequency === "weekly" ? form.daysOfWeek : [],
          days_of_month:
            form.frequency === "monthly" ? daysOfMonthToSave : [],
          window: {
            start: localTimeToUtc(form.windowStart),
            end: localTimeToUtc(form.windowEnd),
          },
        },
      });
      toast.success("Auto-update policy saved.");
      setLocalForm(null);
      setDaysOfMonthText(null);
      queryClient.invalidateQueries({
        queryKey: assistantsUpgradePolicyDetailReadQueryKey({
          path: { id: assistantId },
        }),
      });
    } catch {
      toast.error("Failed to save policy. Please try again.");
    }
  };

  if (policyLoading) {
    return (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading update window settings...
      </div>
    );
  }

  if (policyError) {
    return (
      <p className="text-body-medium-lighter text-[var(--system-negative-strong)]">
        Failed to load update window policy. Refresh the page to try again.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <Toggle
        checked={form.enabled}
        onChange={(next) => update({ enabled: next })}
        label="Automatic updates"
        helperText="Update automatically during a configured time window"
      />

      {form.enabled && (
        <div className="space-y-5">
          <div className="space-y-2">
            <label className="block text-body-small-default text-[var(--content-secondary)]">
              Frequency
            </label>
            <div className="max-w-[400px]">
              <SegmentControl<FrequencyEnum>
                ariaLabel="Frequency"
                value={form.frequency}
                onChange={(f) => {
                  if (f !== "monthly") {
                    setDaysOfMonthText(null);
                  }
                  update({ frequency: f });
                }}
                items={[
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" },
                  { value: "monthly", label: "Monthly" },
                ]}
              />
            </div>
          </div>

          {form.frequency === "weekly" && (
            <div className="space-y-2">
              <label className="block text-body-small-default text-[var(--content-secondary)]">
                Day(s) of week
              </label>
              <div className="flex flex-wrap gap-1.5">
                {DAY_ENTRIES.map(([name, idx]) => (
                  <Button
                    key={idx}
                    variant="outlined"
                    size="compact"
                    active={form.daysOfWeek.includes(idx)}
                    onClick={() => toggleDayOfWeek(idx)}
                  >
                    {name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {form.frequency === "monthly" && (
            <Input
              label="Day(s) of month"
              type="text"
              value={displayDaysOfMonthText}
              onChange={(e) => setDaysOfMonthText(e.target.value)}
              onBlur={(e) => {
                const days = parseDaysOfMonth(e.target.value);
                update({ daysOfMonth: days });
                setDaysOfMonthText(days.join(", "));
              }}
              placeholder="e.g. 1, 15"
              helperText="Comma-separated day numbers (1–31)"
              className="w-48"
            />
          )}

          <div className="space-y-2">
            <label className="block text-body-small-default text-[var(--content-secondary)]">
              Update window{tzAbbrev ? ` (${tzAbbrev})` : ""}
            </label>
            <div className="flex items-center gap-3">
              <Input
                type="time"
                value={form.windowStart}
                onChange={(e) => update({ windowStart: e.target.value })}
              />
              <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
                to
              </span>
              <Input
                type="time"
                value={form.windowEnd}
                onChange={(e) => update({ windowEnd: e.target.value })}
              />
            </div>
          </div>
        </div>
      )}

      <Button
        variant="primary"
        leftIcon={
          policyUpdate.isPending ? (
            <Loader2 className="animate-spin" />
          ) : undefined
        }
        onClick={handleSavePolicy}
        disabled={policyUpdate.isPending || !dirty}
      >
        Save policy
      </Button>
    </div>
  );
}
