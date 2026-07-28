import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { PlatformLoginNotice } from "@/components/platform-login-notice";
import {
    assistantsAccessConsentRetrieveOptions,
    assistantsAccessConsentRetrieveSetQueryData,
} from "@/generated/api/@tanstack/react-query.gen";
import { assistantsAccessConsentPartialUpdate } from "@/generated/api/sdk.gen";
import {
    useActiveAssistantIsPlatformHosted,
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function AccessConsentSetting() {
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

  const { data, isLoading, isError } = useQuery({
    ...assistantsAccessConsentRetrieveOptions(),
    enabled: platformGate === "full" && isPlatformHosted,
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
      assistantsAccessConsentRetrieveSetQueryData(
        queryClient,
        undefined,
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

  // Early return must follow every hook above so gate transitions
  // (e.g. lifecycle flipping to `self_hosted` after the API resolves)
  // never skip a hook and trigger a hook-order violation. The trailing
  // divider in `privacy-page.tsx` is also gated on the same condition
  // so the layout doesn't render two adjacent dividers.
  if (platformGate === "gated") return null;

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
    isLoading ||
    isError ||
    updateConsent.isPending;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-body-medium-default text-[var(--content-default)]">
            Allow Staff Access
          </div>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            When enabled, Vellum Staff will be able to access your assistant
            and its data for debugging purposes. It&apos;s suggested that you
            leave this off and only turn it on temporarily if you need Vellum
            Support&apos;s help in investigating an issue.
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
              {(updateConsent.isPending || isResolving) && (
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
        <PlatformLoginNotice className="mt-3">
          Log in to the Vellum platform to manage admin data access.
        </PlatformLoginNotice>
      )}
    </div>
  );
}
