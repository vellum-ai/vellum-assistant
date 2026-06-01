import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Notice } from "@vellum/design-library/components/notice";
import { Toggle } from "@vellum/design-library/components/toggle";
import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsAccessConsentRetrieveOptions,
  assistantsAccessConsentRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { assistantsAccessConsentPartialUpdate } from "@/generated/api/sdk.gen";
import { usePlatformGate } from "@/hooks/use-platform-gate";

export function AccessConsentSetting() {
  const platformGate = usePlatformGate();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    ...assistantsAccessConsentRetrieveOptions(),
    enabled: platformGate === "full",
  });

  const updateConsent = useMutation({
    mutationFn: async (next: boolean) => {
      const { data: updated } = await assistantsAccessConsentPartialUpdate({
        body: { access_consented: next },
        throwOnError: true,
      });
      return updated;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(
        assistantsAccessConsentRetrieveQueryKey(),
        updated,
      );
      toast.success(
        updated?.access_consented
          ? "Admin data access enabled."
          : "Admin data access disabled.",
      );
    },
    onError: () => {
      toast.error("Failed to update log access consent.");
    },
  });

  // "Allow Vellum administrators to access your data" only makes sense for
  // platform-hosted assistants — Vellum admins cannot reach a self-hosted
  // daemon. Early return must follow every hook above so gate transitions
  // never skip a hook and trigger a hook-order violation. The surrounding
  // dividers in `privacy-page.tsx` are also gated so the layout stays
  // visually clean.
  if (platformGate === "gated") return null;

  const checked = data?.access_consented ?? false;
  const disabled =
    platformGate !== "full" ||
    isLoading ||
    isError ||
    updateConsent.isPending;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-body-medium-default text-[var(--content-default)]">
            Allow admin access to assistant data
          </div>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            Lets Vellum administrators reach privileged data on your assistant
            pod for debugging — today this means tailing the daily assistant log
            at{" "}
            <code className="rounded bg-[var(--surface-base)] px-1.5 font-mono text-[var(--content-secondary)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
              /workspace/data/logs/assistant-YYYY-MM-DD.log
            </code>
            . Off by default. Turn on temporarily when asking support to
            investigate an issue, then turn off when you&apos;re done.
          </p>
          {platformGate === "full" && isError && (
            <p className="mt-1 text-body-small-default text-[var(--system-negative-strong)]">
              Failed to load consent setting.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {platformGate === "disabled" ? null : (
            <>
              {updateConsent.isPending && (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
              )}
              <Toggle
                checked={checked}
                disabled={disabled}
                onChange={() => updateConsent.mutate(!checked)}
              />
            </>
          )}
        </div>
      </div>
      {platformGate === "disabled" && (
        <Notice tone="info" className="mt-3">
          Log in to the Vellum platform to manage admin data access.
        </Notice>
      )}
    </div>
  );
}
