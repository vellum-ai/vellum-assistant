import { t } from "@/i18n";
import { formatRelativeTime as formatRelativeTimeFromNow } from "@/lib/relative-time";

export function formatRelativeTime(epochMs: number): string {
  if (Math.abs(epochMs - Date.now()) < 30_000) {
    return t("memoryFormat.justNow", { ns: "intelligence" });
  }
  return formatRelativeTimeFromNow(epochMs);
}

export function formatAbsoluteDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
