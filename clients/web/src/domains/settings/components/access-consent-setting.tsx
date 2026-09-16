import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { PlatformLoginNotice } from "@/components/platform-login-notice";
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
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

// setTimeout caps at 2^31-1 ms; a week-long grant fits, but clamp anyway.
const MAX_REFETCH_DELAY_MS = 2 ** 31 - 1;

export function AccessConsentSetting() {
  const { t } = useTranslation("settings");
  // platformHostedOnly: this consent toggle is per-assistant — Vellum
  // admins cannot reach a self-hosted daemon, so the setting has no
  // meaning whenever the active assistant is self-hosted. The standard
  // gate would still show it for a logged-in platform session pointed
  // at a self-hosted assistant.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // The privacy page is not mounted under `<ActiveAssistantGate>`, so on
  // a fresh deep-link the lifecycle is still in `{ kind: "loading" }`
  // when we render — during that window the gate returns `"full"`
  // (intentionally, to avoid UI flicker on the surrounding card). Pair
  // it with a strict "positively resolved as platform-hosted" check so
  // the retrieve query doesn't fire until lifecycle has projected a
  // platform-hosted assistant.
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  // Race-window indicator used for the spinner UX only. Narrow to
  // `kind: "loading"` so already-resolved non-hosted lifecycle states
  // (`retired`, `error`) don't show a
  // permanent spinner — they should fall through to the disabled-toggle
  // empty state below.
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const queryClient = useQueryClient();
  // The privacy page is not under `ActiveAssistantGate`, so read the raw
  // store and wait for a non-null id.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const canQuery =
    platformGate === "full" && isPlatformHosted && assistantId !== null;

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
  // again: the server restarts the clock from now.
  const expiresAt =
    data?.access_consented === true ? data.access_consent_expires_at : null;
  useRelativeAgeTick(expiresAt !== null);

  // The target id travels with the mutation rather than being read from
  // render scope in `onSuccess`: if the active assistant changes while the
  // PATCH is in flight, the response must land in the cache of the assistant
  // it was sent for, not whichever one is now on screen.
  const updateConsent = useMutation({
    mutationFn: async ({
      assistantId: targetId,
      next,
    }: {
      assistantId: string;
      next: boolean;
      extend?: boolean;
    }) => {
      const { data: updated } =
        await assistantsAccessConsentDetailPartialUpdate({
          path: { id: targetId },
          body: { access_consented: next },
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
        variables.extend
          ? t("accessConsentSetting.toastExtended")
          : updated?.access_consented
            ? t("accessConsentSetting.toastEnabled")
            : t("accessConsentSetting.toastDisabled"),
      );
    },
    onError: () => {
      toast.error(t("accessConsentSetting.toastUpdateFailed"));
    },
  });

  // Early return must follow every hook above so gate transitions
  // (e.g. lifecycle flipping to `self_hosted` after the API resolves)
  // never skip a hook and trigger a hook-order violation. The trailing
  // divider in `privacy-page.tsx` is also gated on the same condition
  // so the layout doesn't render two adjacent dividers.
  if (platformGate === "gated") {
    return null;
  }

  // `isResolving` controls the spinner adjacent to the toggle, NOT the
  // toggle's disabled state. The `disabled` predicate stays strict on
  // `!isPlatformHosted` — that catches the click during both the
  // deep-link race AND already-resolved non-hosted states where the
  // mutation has no meaning. `isResolving` is narrowed to the genuine
  // lifecycle-loading window so the spinner doesn't get stuck in
  // `retired` / `error`, where the
  // toggle correctly stays disabled and the UI should look like the
  // empty/error state, not "we're still figuring this out."
  const isResolving = platformGate === "full" && isLifecycleLoading;
  const checked = data?.access_consented ?? false;
  const disabled =
    platformGate !== "full" ||
    !isPlatformHosted ||
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
                      extend: true,
                    });
                  }
                }}
              >
                {t("accessConsentSetting.extend")}
              </Button>
            </div>
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
