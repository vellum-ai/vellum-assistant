import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { DetailCard } from "@/components/detail-card";
import { userDeletionRequestCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

export function DeleteAccountSection() {
  // platformHostedOnly: deleting a Vellum platform account from a UI that
  // is actively connected to a self-hosted assistant is confusing /
  // disruptive — the user can switch to a platform-hosted assistant to
  // access this action. The standard gate would still expose it.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const logout = useAuthStore.use.logout();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deleteMutation = useMutation({
    ...userDeletionRequestCreateMutation(),
    onSuccess: async () => {
      toast.success(
        "Account deletion requested. You will be logged out shortly.",
      );
      await logout();
      hardNavigate(routes.account.login);
    },
    onError: () => {
      toast.error("Failed to request account deletion. Please try again.");
    },
  });

  // User accounts are a platform concept — there is no account to delete on
  // a self-hosted assistant. Early return must follow every hook above so
  // gate transitions (e.g. lifecycle flipping to `self_hosted` after the
  // API resolves) never skip a hook and trigger a hook-order violation.
  if (platformGate === "gated") return null;

  return (
    <>
      <DetailCard
        title="Delete Account"
        subtitle="Permanently delete your account and all associated data."
        variant="danger"
      >
        {platformGate === "disabled" ? (
          <Notice tone="info">
            Log in to the Vellum platform to delete your account.
          </Notice>
        ) : (
          <Button
            variant="dangerOutline"
            onClick={() => setConfirmOpen(true)}
            disabled={deleteMutation.isPending}
            className="self-start"
          >
            Delete My Account
          </Button>
        )}
      </DetailCard>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete Account"
        message="This will permanently delete your account and all associated data. This action cannot be undone."
        confirmLabel="Delete Account"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          deleteMutation.mutate({});
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
