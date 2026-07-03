/**
 * A plan checklist in the ACP chat transcript.
 */

import { Circle, CheckCircle2, ListChecks } from "lucide-react";

import { Typography } from "@vellumai/design-library";

export interface AcpChatPlanBlockProps {
  /** Plan entries projected from the run's `plan` event. */
  entries: { label: string; checked: boolean }[];
}

export function AcpChatPlanBlock({ entries }: AcpChatPlanBlockProps) {
  if (entries.length === 0) return null;

  return (
    <div
      data-testid="acp-chat-plan-block"
      className="w-full rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[var(--content-tertiary)]">
        <ListChecks aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <Typography variant="body-small-emphasised" className="text-inherit">
          Plan
        </Typography>
      </div>

      <ul className="flex flex-col gap-1.5">
        {entries.map((entry, idx) => (
          <li
            key={idx}
            data-testid="acp-chat-plan-entry"
            data-checked={entry.checked}
            className="flex items-start gap-2"
          >
            {entry.checked ? (
              <CheckCircle2
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--system-positive-strong)]"
              />
            ) : (
              <Circle
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]"
              />
            )}
            <span
              className={
                entry.checked
                  ? "text-body-small-default text-[var(--content-tertiary)] line-through"
                  : "text-body-small-default text-[var(--content-default)]"
              }
            >
              {entry.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
