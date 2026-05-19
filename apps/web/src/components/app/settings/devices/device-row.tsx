
import { Server } from "lucide-react";

import { Tag } from "@vellum/design-library/components/tag";
import type { Assistant } from "@/generated/api/types.gen.js";

import { UnregisterAssistant } from "@/components/app/settings/devices/unregister-assistant.js";

export interface DeviceRowProps {
  assistant: Assistant;
}

/**
 * Single row in the Devices list. Shows registration metadata
 * (name, machine ID, registered date, status) plus an inline
 * Unregister action.
 */
export function DeviceRow({ assistant }: DeviceRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <Server className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-body-medium-default text-[var(--content-default)]">
              {assistant.name || "Unnamed"}
            </span>
            {assistant.status !== "active" && (
              <Tag tone="warning">{assistant.status}</Tag>
            )}
          </div>
          {assistant.machine_id && (
            <div className="break-all font-mono text-body-small-default text-[var(--content-tertiary)]">
              Machine ID: {assistant.machine_id}
            </div>
          )}
          <div className="text-body-small-default text-[var(--content-tertiary)]">
            Registered {new Date(assistant.created).toLocaleDateString()}
          </div>
        </div>
      </div>

      <UnregisterAssistant localAssistant={assistant} />
    </div>
  );
}
