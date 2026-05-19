
import { useMutation } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { toast } from "@vellum/design-library/components/toast";
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import { userDeletionRequestCreateMutation } from "@/generated/api/@tanstack/react-query.gen.js";
import { useAuth } from "@/lib/auth.js";

export function DeleteAccountSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deletionMutation = useMutation(userDeletionRequestCreateMutation());
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleConfirm = () => {
    if (deletionMutation.isPending) return;
    deletionMutation.mutate(
      {},
      {
        onSuccess: async () => {
          setConfirmOpen(false);
          // The server has destroyed the user; clear the local allauth
          // session and bounce to marketing. `replace` so the deleted
          // account's settings page isn't sitting in browser history.
          await logout();
          navigate("/", { replace: true });
        },
        onError: () => {
          toast.error(
            "Could not delete your account. Please try again or contact support.",
          );
        },
      },
    );
  };

  return (
    <SettingsCard
      variant="danger"
      title="Delete Account"
      subtitle="Permanently delete your Vellum account and all associated data."
    >
      <div className="flex items-center justify-between gap-4">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          This cannot be undone.
        </p>
        <Button
          variant="dangerOutline"
          leftIcon={
            deletionMutation.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Trash2 />
            )
          }
          onClick={() => setConfirmOpen(true)}
          disabled={deletionMutation.isPending}
          data-testid="delete-account-button"
          className="shrink-0"
        >
          Delete my account
        </Button>
        <ConfirmDialog
          open={confirmOpen}
          title="Delete your account?"
          message="This will permanently delete your account and all associated data. This cannot be undone."
          confirmLabel="Delete my account"
          destructive
          onConfirm={handleConfirm}
          onCancel={() => setConfirmOpen(false)}
        />
      </div>
    </SettingsCard>
  );
}
