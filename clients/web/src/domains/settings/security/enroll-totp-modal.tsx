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
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);
  const [code, setCode] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const completedRef = useRef(false);

  const invalidateFactors = () =>
    queryClient.invalidateQueries({ queryKey: userMfaFactorsListQueryKey() });

  const discardFactor = (factorId: string) => {
    void userMfaFactorsDestroy({ path: { id: factorId } })
      .catch(() => undefined)
      .finally(() => void invalidateFactors());
  };

  const enrollMutation = useUserMfaFactorsCreateMutation({
    onSuccess: (data) => {
      setEnrollment(data);
    },
    onError: (error) => {
      const code = mfaErrorCode(error);
      if (code === "no_workos_account") {
        toast.error(
          "Two-factor authentication is only available for Vellum platform accounts.",
        );
      } else if (code === "throttled" || code === "workos_rate_limited") {
        toast.error("Too many attempts. Try again in a minute.");
      } else if (code === "factor_limit_reached") {
        toast.error(
          "An authenticator app is already set up. Remove it before adding another.",
        );
      } else {
        toast.error("Failed to start setup. Please try again.");
      }
      onOpenChange(false);
    },
  });

  const verifyMutation = useUserMfaFactorsVerifyCreateMutation({
    onSuccess: (data) => {
      if (data.valid) {
        completedRef.current = true;
        toast.success("Two-factor authentication is on.");
        void invalidateFactors();
        onOpenChange(false);
      } else {
        setInlineError(
          "That code didn't match. Check your authenticator app and try again.",
        );
      }
    },
    onError: (error) => {
      const errorCode = mfaErrorCode(error);
      if (errorCode === "challenge_already_verified") {
        completedRef.current = true;
        toast.success("Two-factor authentication is on.");
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
        setInlineError(
          "This setup session expired. Scan the new QR code and try again.",
        );
        enrollMutation.mutate({});
        return;
      }
      if (errorCode === "throttled" || errorCode === "workos_rate_limited") {
        setInlineError("Too many attempts. Wait a minute and try again.");
        return;
      }
      setInlineError(
        "Couldn't verify the code. Wait a moment and try again.",
      );
    },
  });

  // Reset on open (not close) so the closing animation doesn't flash.
  useEffect(() => {
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
    void navigator.clipboard
      .writeText(enrollment.secret)
      .then(() => toast.success("Setup key copied."))
      .catch(() => toast.error("Couldn't copy the setup key."));
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
          <Modal.Title>Set up authenticator app</Modal.Title>
          <Modal.Description>
            Scan the QR code with an authenticator app such as Google
            Authenticator or 1Password, then enter the 6-digit code it
            shows.
          </Modal.Description>
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
                alt="QR code for your authenticator app"
                className="h-44 w-44 rounded-lg bg-white p-2"
              />
              <div className="flex w-full flex-col gap-1">
                <span className="text-body-small-default text-[var(--content-tertiary)]">
                  Can&apos;t scan it? Enter this setup key manually:
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
                  6-digit code
                </label>
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
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
            Cancel
          </Button>
          <Button
            onClick={submitCode}
            disabled={
              enrollment === null ||
              code.length !== 6 ||
              verifyMutation.isPending
            }
          >
            {verifyMutation.isPending ? "Verifying…" : "Verify"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
