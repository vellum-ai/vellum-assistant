import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import {
  exportLocalDebugBundle,
  pollLocalExportJob,
} from "@/domains/settings/teleport/teleport-gateway-client";
import { assistantsDebugBundleUploadUrlCreate } from "@/generated/api/sdk.gen";
import { useTranslation } from "@/i18n";
import { getLocalGatewayUrl, getSelectedAssistant } from "@/lib/local-mode";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

const POLL_INTERVAL_MS = 2_000;
const EXPORT_TIMEOUT_MS = 15 * 60 * 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Vellum staff cannot reach a self-hosted assistant, so the owner sends
 * them a copy instead: the daemon's debug export (workspace, logs, and the
 * gateway's own database, never credentials) uploaded to the platform's
 * debug-bundle bucket, where it is kept for seven days.
 *
 * Only the desktop app on the machine running the assistant can ask the
 * daemon to export, so the button appears only when a local gateway is
 * resolved. Everywhere else the row says where to go.
 */
export function DebugBundleExport({
  assistantId,
  pollIntervalMs = POLL_INTERVAL_MS,
}: {
  assistantId: string;
  /** How often to ask the daemon whether the export finished. */
  pollIntervalMs?: number;
}) {
  const { t } = useTranslation("settings");
  const [sentAt, setSentAt] = useState<Date | null>(null);
  const local = getSelectedAssistant();
  const canExport = local !== null && getLocalGatewayUrl(local) !== null;

  const exportBundle = useMutation({
    mutationFn: async () => {
      if (!local) {
        throw new Error("no local assistant");
      }
      // 1. The platform mints the upload URL, and refuses it unless the
      //    staff access grant is active. 2. The daemon builds and uploads
      //    the bundle. 3. Wait for the job so the owner sees a real result.
      const { data } = await assistantsDebugBundleUploadUrlCreate({
        path: { id: assistantId },
        throwOnError: true,
      });
      const jobId = await exportLocalDebugBundle(local, data.url);
      const deadline = Date.now() + EXPORT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        if ((await pollLocalExportJob(local, jobId)) === "complete") {
          return;
        }
      }
      throw new Error("timed out");
    },
    onSuccess: () => {
      setSentAt(new Date());
      toast.success(t("debugBundleExport.toastSent"));
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      toast.error(
        message
          ? t("debugBundleExport.toastFailedWithReason", { reason: message })
          : t("debugBundleExport.toastFailed"),
      );
    },
  });

  return (
    <div className="mt-3 rounded-md border border-[var(--surface-active)] p-3">
      <p className="text-body-small-lighter text-[var(--content-tertiary)]">
        {t("debugBundleExport.description")}
      </p>
      {canExport ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="outlined"
            size="compact"
            disabled={exportBundle.isPending}
            onClick={() => exportBundle.mutate()}
          >
            {exportBundle.isPending && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            )}
            {exportBundle.isPending
              ? t("debugBundleExport.exporting")
              : t("debugBundleExport.export")}
          </Button>
          {sentAt !== null && !exportBundle.isPending && (
            <p className="text-body-small-lighter text-[var(--content-tertiary)]">
              {t("debugBundleExport.sentAt", {
                time: sentAt.toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-body-small-lighter text-[var(--content-tertiary)]">
          {t("debugBundleExport.useDesktopApp")}
        </p>
      )}
    </div>
  );
}
