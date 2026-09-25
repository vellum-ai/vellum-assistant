import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type { HandleCheckResult } from "../types";
import { AssistantInboxPageFrame } from "./assistant-inbox-page-frame";
import { EmailAddressFields } from "./email-address-fields";

/** Long enough that a probe is not fired per keystroke. */
const HANDLE_CHECK_DELAY_MS = 400;

export interface AssistantInboxSetupCardProps {
  /** Whose address this creates; the preview pill shows their avatar. */
  assistantId: string;
  /** The assistant's current handle. */
  handle: string;
  rootDomain: string;
  /**
   * The handle is still open: no domain has been registered, so whatever
   * handle is confirmed here becomes the subdomain, and the assistant's
   * public handle, for good. Draws the handle as a field, with the warning
   * that says so. False once a domain exists, when the handle is fixed text.
   */
  handleEditable?: boolean;
  /**
   * Probes a handle the user typed. Only a negative answer is shown: the
   * registration is the authority on whether a handle can be claimed, so the
   * card never promises one is free, it only warns when one is not. A probe
   * that throws is ignored for the same reason.
   */
  checkHandle?: (
    handle: string,
    signal: AbortSignal,
  ) => Promise<HandleCheckResult>;
  /** The registration's own refusal, shown under the fields. */
  error?: string | null;
  /** The draft changed, so a refusal of the last one no longer applies. */
  onDraftChange?: () => void;
  onConfirm: (draft: { prefix: string; handle: string }) => void;
  /** The registration is in flight; the action holds. */
  busy?: boolean;
  /** Leaves the setup without an address. Without it no back control is drawn. */
  onBack?: () => void;
}

/**
 * The inbox on an entitled plan with no address yet. When a domain already
 * exists the handle is settled, so the local part of the address is the one
 * field. When none does, the handle is still the user's to choose, and this
 * is the moment to choose it: an assistant that skipped the domain step at
 * onboarding carries a generated handle, and registering turns whatever is
 * here into a permanent subdomain. So the handle is a field too, held to
 * what a subdomain allows, probed as it is typed, with the warning that it
 * cannot be changed afterwards. Beneath the fields the address they produce
 * is drawn as the identity pill, so the preview reads as the assistant.
 *
 * Drawn in the inbox's page frame, as the design has it: a header row with
 * the way back and the page's name, and the form centred in the panel
 * below, so setting up reads as a step of the inbox rather than a dialog
 * over it.
 */
export function AssistantInboxSetupCard({
  assistantId,
  handle: initialHandle,
  rootDomain,
  handleEditable = false,
  checkHandle,
  error = null,
  onDraftChange,
  onConfirm,
  busy = false,
  onBack,
}: AssistantInboxSetupCardProps) {
  const { t } = useTranslation("assistant-inbox");
  const [prefix, setPrefix] = useState("hi");
  const [handle, setHandle] = useState(initialHandle);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  /* The handle arrives with the platform's assistant listing, which can land
     after first paint; adopt it until the user has typed one of their own. */
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) {
      setHandle(initialHandle);
    }
  }, [initialHandle, touched]);

  useEffect(() => {
    setCheckMessage(null);
    if (
      !handleEditable ||
      !checkHandle ||
      !handle ||
      handle === initialHandle
    ) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkHandle(handle, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted && !result.available) {
            setCheckMessage(result.message);
          }
        })
        .catch(() => {
          // Advisory only: the registration decides, so a failed probe is silent.
        });
    }, HANDLE_CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [checkHandle, handle, handleEditable, initialHandle]);

  const problem = checkMessage ?? error;

  return (
    <AssistantInboxPageFrame
      onBack={onBack}
      centered
      peekAssistantId={assistantId}
    >
      <div className="flex w-full max-w-[560px] flex-col items-center gap-10 px-4 py-1 text-center">
        <h2
          className="text-[var(--content-emphasised)]"
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: "44px",
            fontWeight: 400,
            lineHeight: 1.15,
            letterSpacing: "0.4px",
          }}
        >
          {t("assistantInboxSetupCard.headline")}
        </h2>

        <div className="flex w-full flex-col items-center gap-4">
          <p className="text-body-medium-default text-[var(--content-emphasised)]">
            {handleEditable
              ? t("assistantInboxSetupCard.fieldLabelChooseHandle")
              : t("assistantInboxSetupCard.fieldLabel")}
          </p>
          <div className="flex max-w-full flex-col items-center gap-2">
            <div className="flex max-w-full items-center rounded-2xl border border-[var(--border-base)] bg-[var(--surface-lift)] p-2">
              <EmailAddressFields
                prefix={prefix}
                handle={handle}
                rootDomain={rootDomain}
                onPrefixChange={(value) => {
                  setPrefix(value);
                  onDraftChange?.();
                }}
                onHandleChange={
                  handleEditable
                    ? (value) => {
                        setTouched(true);
                        setHandle(value);
                        onDraftChange?.();
                      }
                    : undefined
                }
                handleInvalid={problem !== null}
                disabled={busy}
                autoFocus
              />
            </div>
            {problem ? (
              <p
                role="alert"
                className="text-center text-body-small-default text-[var(--system-negative-strong)]"
              >
                {problem}
              </p>
            ) : null}
          </div>
          {handleEditable ? (
            <p className="max-w-sm text-body-small-lighter text-[var(--content-tertiary)]">
              {t("assistantInboxSetupCard.immutableNotice")}
            </p>
          ) : null}
        </div>

        <Button
          variant="primary"
          disabled={!prefix || !handle || busy || checkMessage !== null}
          onClick={() => onConfirm({ prefix, handle })}
        >
          {t("assistantInboxSetupCard.confirm")}
        </Button>
      </div>
    </AssistantInboxPageFrame>
  );
}
