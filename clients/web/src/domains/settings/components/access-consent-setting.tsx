import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { DebugBundleExport } from "@/domains/settings/components/debug-bundle-export";
import {
  formatRelativeAge,
  useRelativeAgeTick,
} from "@/domains/settings/pair-device/relative-age";
import {
  assistantsAccessConsentDetailReadOptions,
  assistantsAccessConsentDetailReadSetQueryData,
} from "@/generated/api/@tanstack/react-query.gen";
import { assistantsAccessConsentDetailPartialUpdate } from "@/generated/api/sdk.gen";
import {
  useActiveAssistantIsSelfHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { usePlatformAssistantId } from "@/hooks/use-platform-assistant-id";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

// setTimeout caps at 2^31-1 ms; a week-long grant fits, but clamp anyway.
const MAX_REFETCH_DELAY_MS = 2 ** 31 - 1;

export function AccessConsentSetting() {
  const { t } = useTranslation("settings");
  // The grant applies to hosted and self-hosted assistants alike: staff
  // open a hosted assistant's disk directly, and a self-hosted one through
  // the debug bundle the owner exports below. So the standard gate, not
  // `platformHostedOnly`.
  const platformGate = usePlatformGate();
  const isSelfHosted = useActiveAssistantIsSelfHosted();
  // Race-window indicator used for the spinner UX only. Narrow to
  // `kind: "loading"` so already-resolved lifecycle states (`retired`,
  // `error`) don't show a permanent spinner.
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const queryClient = useQueryClient();
  // The privacy page is not under `ActiveAssistantGate`, so read the raw
  // store and wait for a non-null id. In local mode that id is a lockfile
  // slug; platform routes take only the registered UUID, so resolve it
  // first (a UUID resolves to itself).
  const activeId = useResolvedAssistantsStore.use.activeAssistantId();
  const { platformAssistantId: assistantId, isLoading: isResolvingId } =
    usePlatformAssistantId(activeId, platformGate === "full");
  const canQuery = platformGate === "full" && assistantId !== null;

  const { data, isLoading, isError } = useQuery({
    ...assistantsAccessConsentDetailReadOptions({
      path: { id: assistantId ?? "" },
    }),
    enabled: canQuery,
    // Refetch once the grant lapses so an open tab flips to off on its own
    // instead of showing a toggle the server no longer honors.
    refetchInterval: (query) => {
      const ends = query.state.data?.access_consent_expires_at;
      if (!query.state.data?.access_consented || !ends) {
        return false;
      }
      const msUntilEnd = new Date(ends).getTime() - Date.now() + 1_000;
      return Math.min(Math.max(msUntilEnd, 1_000), MAX_REFETCH_DELAY_MS);
    },
  });

  // A grant lapses on its own (24h by default). Extending is just enabling
  // again: the server restarts the clock from now. The owner can instead keep
  // it on until they turn it off.
  const isOn = data?.access_consented === true;
  // A platform from before the override omits this field. Then the button
  // to keep access on is hidden, since that platform could not honor it.
  const canKeepOn =
    isOn && typeof data.access_consent_never_expires === "boolean";
  const neverExpires = isOn && data.access_consent_never_expires === true;
  const expiresAt =
    isOn && !neverExpires ? data.access_consent_expires_at : null;
  useRelativeAgeTick(expiresAt !== null);

  // The target id travels with the mutation rather than being read from
  // render scope in `onSuccess`: if the active assistant changes while the
  // PATCH is in flight, the response must land in the cache of the assistant
  // it was sent for, not whichever one is now on screen.
  const updateConsent = useMutation({
    mutationFn: async ({
      assistantId: targetId,
      next,
      mode,
    }: {
      assistantId: string;
      next: boolean;
      /** Why the owner is enabling, for the toast and the request body. */
      mode?: "extend" | "keepOn" | "expireAgain";
    }) => {
      const { data: updated } =
        await assistantsAccessConsentDetailPartialUpdate({
          path: { id: targetId },
          body: {
            access_consented: next,
            ...(mode === "keepOn" ? { never_expires: true } : {}),
          },
          throwOnError: true,
        });
      return updated;
    },
    onSuccess: (updated, variables) => {
      assistantsAccessConsentDetailReadSetQueryData(
        queryClient,
        { path: { id: variables.assistantId } },
        updated,
      );
      toast.success(
        variables.mode === "extend"
          ? t("accessConsentSetting.toastExtended")
          : variables.mode === "keepOn"
            ? t("accessConsentSetting.toastKeptOn")
            : variables.mode === "expireAgain"
              ? t("accessConsentSetting.toastExpiring")
              : updated?.access_consented
                ? t("accessConsentSetting.toastEnabled")
                : t("accessConsentSetting.toastDisabled"),
      );
    },
    onError: () => {
      toast.error(t("accessConsentSetting.toastUpdateFailed"));
    },
  });

  // Early return must follow every hook above so gate transitions never
  // skip a hook. The trailing divider in `privacy-page.tsx` is gated on
  // the same condition so the layout doesn't render two adjacent dividers.
  if (platformGate === "gated") {
    return null;
  }

  // `isResolving` controls the spinner adjacent to the toggle, not its
  // disabled state, and is narrowed to the genuine lifecycle-loading
  // window so it doesn't get stuck in `retired` / `error`.
  const isResolving =
    platformGate === "full" && (isLifecycleLoading || isResolvingId);
  const checked = data?.access_consented ?? false;
  const disabled =
    platformGate !== "full" ||
    assistantId === null ||
    isLoading ||
    isError ||
    updateConsent.isPending;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-body-medium-default text-[var(--content-default)]">
            {t("accessConsentSetting.title")}
          </div>
          <p className="mt-1 text-body-small-lighter text-[var(--content-tertiary)]">
            {t("accessConsentSetting.description")}
          </p>
          {platformGate === "full" && isError && (
            <p className="mt-1 text-body-small-lighter text-[var(--system-negative-strong)]">
              {t("accessConsentSetting.loadError")}
            </p>
          )}
          {expiresAt !== null && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-body-small-lighter text-[var(--content-tertiary)]">
                {t("accessConsentSetting.expiresAt", {
                  when: formatRelativeAge(expiresAt),
                })}
              </p>
              <Button
                variant="outlined"
                size="compact"
                disabled={disabled}
                onClick={() => {
                  if (assistantId) {
                    updateConsent.mutate({
                      assistantId,
                      next: true,
                      mode: "extend",
                    });
                  }
                }}
              >
                {t("accessConsentSetting.extend")}
              </Button>
              {canKeepOn && (
                <Button
                  variant="outlined"
                  size="compact"
                  disabled={disabled}
                  onClick={() => {
                    if (assistantId) {
                      updateConsent.mutate({
                        assistantId,
                        next: true,
                        mode: "keepOn",
                      });
                    }
                  }}
                >
                  {t("accessConsentSetting.keepOn")}
                </Button>
              )}
            </div>
          )}
          {neverExpires && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-body-small-lighter text-[var(--content-tertiary)]">
                {t("accessConsentSetting.staysOn")}
              </p>
              <Button
                variant="outlined"
                size="compact"
                disabled={disabled}
                onClick={() => {
                  if (assistantId) {
                    updateConsent.mutate({
                      assistantId,
                      next: true,
                      mode: "expireAgain",
                    });
                  }
                }}
              >
                {t("accessConsentSetting.expireAgain")}
              </Button>
            </div>
          )}
          {isOn && isSelfHosted && assistantId !== null && (
            <DebugBundleExport assistantId={assistantId} />
          )}
        </div>
        <div className="flex items-center gap-2">
          {platformGate === "disabled" ? null : (
            <>
              {(updateConsent.isPending || isResolving) && (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
              )}
              <Toggle
                checked={checked}
                disabled={disabled}
                onChange={() => {
                  if (assistantId) {
                    updateConsent.mutate({ assistantId, next: !checked });
                  }
                }}
              />
            </>
          )}
        </div>
      </div>
      {platformGate === "disabled" && (
        <PlatformLoginNotice className="mt-3">
          {t("accessConsentSetting.loginNotice")}
        </PlatformLoginNotice>
      )}
    </div>
  );
}
