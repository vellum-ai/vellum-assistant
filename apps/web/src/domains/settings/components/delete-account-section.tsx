import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { toast } from "@vellum/design-library/components/toast";
import { DetailCard } from "@/components/detail-card";
import { userDeletionRequestCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

export function DeleteAccountSection() {
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

  return (
    <>
      <DetailCard
        title="Delete Account"
        subtitle="Permanently delete your account and all associated data."
        variant="danger"
      >
        <Button
          variant="dangerOutline"
          onClick={() => setConfirmOpen(true)}
          disabled={deleteMutation.isPending}
          className="self-start"
        >
          Delete My Account
        </Button>
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
