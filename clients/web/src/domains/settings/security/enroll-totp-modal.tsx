import { useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { MfaEnrollResponse } from "@/generated/api/types.gen";
import {
  userMfaFactorsListQueryKey,
  useUserMfaFactorsCreateMutation,
  useUserMfaFactorsVerifyCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { userMfaFactorsDestroy } from "@/generated/api/sdk.gen";
import { useTranslation } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";

import { mfaErrorCode } from "./mfa-error";

interface EnrollTotpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Enrolls on open; verifying the first code activates the factor.
 * Closing before verification best-effort deletes the unverified factor.
 */
export function EnrollTotpModal({ open, onOpenChange }: EnrollTotpModalProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);
  const [code, setCode] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const completedRef = useRef(false);
  // Latest open state for mutation callbacks, which outlive a close.
  const openRef = useRef(open);

  const invalidateFactors = () =>
    queryClient.invalidateQueries({ queryKey: userMfaFactorsListQueryKey() });

  const discardFactor = (factorId: string) => {
    void userMfaFactorsDestroy({ path: { id: factorId } })
      .catch(() => undefined)
      .finally(() => void invalidateFactors());
  };

  const enrollMutation = useUserMfaFactorsCreateMutation({
    onSuccess: (data) => {
      // Enrollment that resolves after the modal closed would dangle
      // unreferenced; nothing else can clean it up.
      if (!openRef.current) {
        discardFactor(data.factor_id);
        return;
      }
      setEnrollment(data);
    },
    onError: (error) => {
      const code = mfaErrorCode(error);
      if (code === "no_workos_account") {
        toast.error(t("enrollTotpModal.toastNoWorkosAccount"));
      } else if (code === "throttled" || code === "workos_rate_limited") {
        toast.error(t("enrollTotpModal.toastThrottled"));
      } else if (code === "factor_limit_reached") {
        toast.error(t("enrollTotpModal.toastFactorLimitReached"));
      } else {
        toast.error(t("enrollTotpModal.toastStartFailed"));
      }
      onOpenChange(false);
    },
  });

  const verifyMutation = useUserMfaFactorsVerifyCreateMutation({
    onSuccess: (data) => {
      if (data.valid) {
        completedRef.current = true;
        toast.success(t("enrollTotpModal.toastEnabled"));
        void invalidateFactors();
        onOpenChange(false);
      } else {
        setInlineError(t("enrollTotpModal.errorCodeMismatch"));
      }
    },
    onError: (error) => {
      const errorCode = mfaErrorCode(error);
      if (errorCode === "challenge_already_verified") {
        completedRef.current = true;
        toast.success(t("enrollTotpModal.toastEnabled"));
        void invalidateFactors();
        onOpenChange(false);
        return;
      }
      if (
        errorCode === "challenge_expired" ||
        errorCode === "challenge_not_found"
      ) {
        if (enrollment) {
          discardFactor(enrollment.factor_id);
        }
        setEnrollment(null);
        setCode("");
        setInlineError(t("enrollTotpModal.errorSessionExpired"));
        enrollMutation.mutate({});
        return;
      }
      if (errorCode === "throttled" || errorCode === "workos_rate_limited") {
        setInlineError(t("enrollTotpModal.errorThrottledInline"));
        return;
      }
      setInlineError(t("enrollTotpModal.errorVerifyFailed"));
    },
  });

  // Reset on open (not close) so the closing animation doesn't flash.
  useEffect(() => {
    openRef.current = open;
    if (!open) {
      return;
    }
    completedRef.current = false;
    setEnrollment(null);
    setCode("");
    setInlineError(null);
    enrollMutation.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per open; `mutate` is stable
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    // Closing mid-verify would discard the factor the in-flight request
    // may be activating; every dismissal path funnels through here.
    if (!next && verifyMutation.isPending) {
      return;
    }
    if (!next && enrollment && !completedRef.current) {
      discardFactor(enrollment.factor_id);
    }
    onOpenChange(next);
  };

  const copySecret = () => {
    if (!enrollment) {
      return;
    }
    copyToClipboard(enrollment.secret, {
      successMessage: t("enrollTotpModal.copySuccess"),
      errorMessage: t("enrollTotpModal.copyError"),
    });
  };

  const submitCode = () => {
    if (!enrollment || code.length !== 6 || verifyMutation.isPending) {
      return;
    }
    setInlineError(null);
    verifyMutation.mutate({
      body: { challenge_id: enrollment.challenge_id, code },
    });
  };

  return (
    <Modal.Root open={open} onOpenChange={handleOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>{t("enrollTotpModal.title")}</Modal.Title>
          <Modal.Description>{t("enrollTotpModal.description")}</Modal.Description>
        </Modal.Header>
        <Modal.Body>
          {enrollment === null ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--content-tertiary)]" />
            </div>
          ) : (
            <form
              className="flex flex-col items-center gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                submitCode();
              }}
            >
              <img
                src={enrollment.qr_code}
                alt={t("enrollTotpModal.qrCodeAlt")}
                className="h-44 w-44 rounded-lg bg-white p-2"
              />
              <div className="flex w-full flex-col gap-1">
                <span className="text-body-small-default text-[var(--content-tertiary)]">
                  {t("enrollTotpModal.manualKeyHint")}
                </span>
                <button
                  type="button"
                  onClick={copySecret}
                  className="flex cursor-pointer items-center gap-2 self-start font-mono text-body-small-default text-[var(--content-default)] hover:text-[var(--content-emphasised)]"
                >
                  <span className="break-all text-left">
                    {enrollment.secret}
                  </span>
                  <Copy className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
              <div className="flex w-full flex-col gap-1">
                <label
                  htmlFor="totp-code"
                  className="text-body-small-default text-[var(--content-tertiary)]"
                >
                  {t("enrollTotpModal.codeLabel")}
                </label>
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder={t("enrollTotpModal.codePlaceholder")}
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                />
                {inlineError && (
                  <p
                    role="alert"
                    className="text-body-small-default text-[var(--system-negative-strong)]"
                  >
                    {inlineError}
                  </p>
                )}
              </div>
            </form>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outlined"
            onClick={() => handleOpenChange(false)}
            disabled={verifyMutation.isPending}
          >
            {t("enrollTotpModal.cancel")}
          </Button>
          <Button
            onClick={submitCode}
            disabled={
              enrollment === null ||
              code.length !== 6 ||
              verifyMutation.isPending
            }
          >
            {verifyMutation.isPending
              ? t("enrollTotpModal.verifying")
              : t("enrollTotpModal.verify")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
