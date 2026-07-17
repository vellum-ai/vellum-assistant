import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { useUserDeletionRequestCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import {
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { useAuthStore } from "@/stores/auth-store";
import { clearConsentForUser } from "@/lib/consent/consent-persistence";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { toast } from "@vellumai/design-library/components/toast";

export function DeleteAccountSection() {
  // platformHostedOnly: deleting a Vellum platform account from a UI that
  // is actively connected to a self-hosted assistant is confusing /
  // disruptive — the user can switch to a platform-hosted assistant to
  // access this action. The standard gate would still expose it.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // Settings routes are NOT mounted under `<ActiveAssistantGate>`, so a
  // fresh deep-link to the privacy page renders with lifecycle still in
  // `{ kind: "loading" }`. The gate above returns `"full"` during that
  // window (intentional — prevents chrome flicker), but a click on the
  // delete button during the race would fire `userDeletionRequestCreate`
  // before we know which assistant is active. The button MUST stay
  // disabled until lifecycle lands a resolution — note this is the
  // genuine loading window only; already-resolved non-hosted states
  // (`retired`, `error`) should NOT block account deletion, since the
  // user's platform account exists independently of any assistant.
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const userId = useAuthStore.use.user()?.id ?? null;
  const logout = useAuthStore.use.logout();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deleteMutation = useUserDeletionRequestCreateMutation({
    onSuccess: async () => {
      toast.success(
        "Account deletion requested. You will be logged out shortly.",
      );
      clearConsentForUser(userId);
      await logout();
      hardNavigate(routes.account.login);
    },
    onError: () => {
      toast.error("Failed to request account deletion. Please try again.");
    },
  });

  const isResolving = platformGate === "full" && isLifecycleLoading;

  // Dialog lifetime can span gate transitions: a user can open the dialog
  // while resolved-as-hosted, then trigger an assistant switch (lifecycle
  // re-enters `loading`), then press Confirm. The opener-button gate above
  // does NOT protect against that — `confirmOpen` is already true and the
  // ConfirmDialog stays mounted. Close the dialog when `isResolving`
  // flips true so the user sees it dismiss; the disabled button + spinner
  // then explain the state. Belt-and-suspenders: also guard `onConfirm`
  // for the same-tick edge case.
  useEffect(() => {
    if (isResolving && confirmOpen) {
      setConfirmOpen(false);
    }
  }, [isResolving, confirmOpen]);

  // User accounts are a platform concept — there is no account to delete on
  // a self-hosted assistant. Early return must follow every hook above so
  // gate transitions (e.g. lifecycle flipping to `self_hosted` after the
  // API resolves) never skip a hook and trigger a hook-order violation.
  if (platformGate === "gated") {
    return null;
  }

  return (
    <>
      <section className="flex flex-col gap-2">
        <h3 className="text-title-small text-[var(--content-emphasised)]">
          Delete Account
        </h3>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          Permanently delete your account and all associated data.
        </p>
        <div className="mt-1">
          {platformGate === "disabled" ? (
            <PlatformLoginNotice>
              Log in to the Vellum platform to delete your account.
            </PlatformLoginNotice>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="dangerOutline"
                onClick={() => setConfirmOpen(true)}
                disabled={deleteMutation.isPending || isResolving}
                className="self-start"
              >
                Delete My Account
              </Button>
              {isResolving && (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
              )}
            </div>
          )}
        </div>
      </section>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete Account"
        message="This will permanently delete your account and all associated data. This action cannot be undone."
        confirmLabel="Delete Account"
        destructive
        onConfirm={() => {
          // Defensive: the useEffect above closes the dialog when
          // `isResolving` flips true, but a click landing in the same
          // tick as the transition would still reach this handler.
          if (isResolving) {
            setConfirmOpen(false);
            return;
          }
          setConfirmOpen(false);
          deleteMutation.mutate({});
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
