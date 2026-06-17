import { Monitor, Smartphone } from "lucide-react";

import type { Assistant } from "@/generated/api/types.gen";

function formatDate(dateStr: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(dateStr));
}

interface DeviceRowProps {
  assistant: Assistant;
}

export function DeviceRow({ assistant }: DeviceRowProps) {
  const raw = assistant as Assistant & {
    platform?: string;
    hostname?: string;
  };
  const isIOS = raw.platform === "ios";
  const Icon = isIOS ? Smartphone : Monitor;
  const label =
    assistant.name ||
    (isIOS ? "iOS Device" : raw.hostname || "Unknown Device");

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border-base)] px-4 py-3">
      <Icon className="h-5 w-5 shrink-0 text-[var(--content-secondary)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-medium-default text-[var(--content-default)]">
          {label}
        </div>
        <div className="text-body-small-default text-[var(--content-tertiary)]">
          {raw.hostname && (
            <span className="mr-3">{raw.hostname}</span>
          )}
          {assistant.created && (
            <span>Registered {formatDate(assistant.created)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
