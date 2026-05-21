import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { toast } from "@vellum/design-library/components/toast";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { userDeletionRequestCreateMutation } from "@/generated/api/@tanstack/react-query.gen.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { routes } from "@/utils/routes.js";

export function DeleteAccountSection() {
  const navigate = useNavigate();
  const logout = useAuthStore.use.logout();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deleteMutation = useMutation({
    ...userDeletionRequestCreateMutation(),
    onSuccess: async () => {
      toast.success(
        "Account deletion requested. You will be logged out shortly.",
      );
      await logout();
      navigate(routes.account.login);
    },
    onError: () => {
      toast.error("Failed to request account deletion. Please try again.");
    },
  });

  return (
    <>
      <SettingsCard
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
      </SettingsCard>
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
