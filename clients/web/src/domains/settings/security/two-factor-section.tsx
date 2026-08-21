import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Smartphone } from "lucide-react";
import { useState } from "react";

import type { MfaFactor } from "@/generated/api/types.gen";
import {
  userMfaFactorsListOptions,
  userMfaFactorsListQueryKey,
  useUserMfaFactorsDestroyMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { Trans, useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

import { EnrollTotpModal } from "./enroll-totp-modal";
import { mfaErrorCode } from "./mfa-error";

function formatAddedDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Factor list with add/remove; rendered only when the gate is `"full"`. */
export function TwoFactorSection() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MfaFactor | null>(null);

  const factorsQuery = useQuery({ ...userMfaFactorsListOptions() });
  const factors = factorsQuery.data ?? [];

  const invalidateFactors = () =>
    queryClient.invalidateQueries({ queryKey: userMfaFactorsListQueryKey() });

  const deleteMutation = useUserMfaFactorsDestroyMutation({
    onSuccess: () => {
      toast.success(t("twoFactorSection.toastRemoved"));
      void invalidateFactors();
    },
    onError: (error) => {
      // Already gone = goal state.
      if (mfaErrorCode(error) === "factor_not_found") {
        void invalidateFactors();
        return;
      }
      toast.error(t("twoFactorSection.toastRemoveFailed"));
    },
  });

  return (
    <div className="flex flex-col gap-4">
      {factorsQuery.isPending ? (
        <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-body-medium-default">
            {t("twoFactorSection.loading")}
          </span>
        </div>
      ) : factorsQuery.isError ? (
        <Notice tone="error">
          <Trans
            ns="settings"
            i18nKey="twoFactorSection.loadError"
            components={{
              retryButton: (
                <button
                  type="button"
                  className="cursor-pointer underline"
                  onClick={() => void factorsQuery.refetch()}
                />
              ),
            }}
          />
        </Notice>
      ) : factors.length === 0 ? (
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          {t("twoFactorSection.emptyDescription")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--border-base)]">
          {factors.map((factor) => (
            <li
              key={factor.id}
              className="flex items-center justify-between gap-3 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Smartphone className="h-5 w-5 shrink-0 text-[var(--content-tertiary)]" />
                <div className="min-w-0">
                  <div className="text-body-medium-default text-[var(--content-default)]">
                    {t("twoFactorSection.authenticatorApp")}
                  </div>
                  <div className="truncate text-body-small-default text-[var(--content-tertiary)]">
                    {factor.user}
                    {factor.created_at
                      ? t("twoFactorSection.addedOn", {
                          date: formatAddedDate(factor.created_at),
                        })
                      : ""}
                  </div>
                </div>
              </div>
              <Button
                variant="dangerOutline"
                onClick={() => setPendingDelete(factor)}
                disabled={deleteMutation.isPending}
              >
                {t("twoFactorSection.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {!factorsQuery.isPending &&
        !factorsQuery.isError &&
        factors.length === 0 && (
          <Button onClick={() => setEnrollOpen(true)} className="self-start">
            {t("twoFactorSection.addAuthenticatorApp")}
          </Button>
        )}

      <EnrollTotpModal open={enrollOpen} onOpenChange={setEnrollOpen} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("twoFactorSection.removeDialogTitle")}
        message={t("twoFactorSection.removeDialogMessage")}
        confirmLabel={t("twoFactorSection.removeDialogConfirm")}
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            deleteMutation.mutate({ path: { id: pendingDelete.id } });
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
