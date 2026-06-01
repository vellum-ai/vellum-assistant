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
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";

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

  // Early return must follow every hook above so gate transitions
  // (e.g. lifecycle flipping to `self_hosted` after the API resolves)
  // never skip a hook and trigger a hook-order violation. The trailing
  // divider in `privacy-page.tsx` is also gated on the same condition
  // so the layout doesn't render two adjacent dividers.
  if (platformGate === "gated") return null;

  // Treat the "lifecycle not yet resolved" window as still-loading. A
  // `useQuery` with `enabled: false` reports `isLoading: false`, so
  // without `!isPlatformHosted` the toggle would render interactive
  // during the resolution race (the gate intentionally says `"full"`
  // to avoid chrome flicker, but we genuinely don't know yet whether
  // the assistant is platform-hosted). A click during that window
  // would fire `assistantsAccessConsentPartialUpdate` against a
  // potentially self-hosted target — exactly the doomed request the
  // gate exists to prevent. Include the strict hosting signal in the
  // disabled predicate so the mutation can only fire post-resolution.
  const isResolving = platformGate === "full" && !isPlatformHosted;
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
        <Notice tone="info" className="mt-3">
          Log in to the Vellum platform to manage admin data access.
        </Notice>
      )}
    </div>
  );
}
