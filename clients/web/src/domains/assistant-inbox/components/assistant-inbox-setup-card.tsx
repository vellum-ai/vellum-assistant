import { useEffect, useState } from "react";

import { Button, Notice } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type { HandleCheckResult } from "../types";
import { AddressPill } from "./address-pill";
import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailAddressFields } from "./email-address-fields";
import { InboxCard } from "./inbox-card";

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
 * There is one way out, forward: skipping would leave the inbox with
 * nothing to show.
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
  const previewPrefix = prefix || t("emailAddressFields.prefixPlaceholder");
  const previewHandle = handle || t("emailAddressFields.handlePlaceholder");

  return (
    <AssistantInboxShell>
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <InboxCard
          title={t("assistantInboxSetupCard.title")}
          subtitle={
            handleEditable
              ? t("assistantInboxSetupCard.subtitleChooseHandle")
              : t("assistantInboxSetupCard.subtitle")
          }
          footerAlign="center"
          footer={
            <Button
              variant="primary"
              disabled={!prefix || !handle || busy || checkMessage !== null}
              onClick={() => onConfirm({ prefix, handle })}
            >
              {t("assistantInboxSetupCard.getStarted")}
            </Button>
          }
        >
          <div className="flex flex-col items-center gap-4">
            <div className="flex max-w-full flex-col items-center gap-1.5">
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
              {problem ? (
                <p
                  role="alert"
                  className="text-center text-body-small-default text-[var(--system-negative-strong)]"
                >
                  {problem}
                </p>
              ) : null}
            </div>
            <AddressPill
              assistantId={assistantId}
              address={`${previewPrefix}@${previewHandle}.${rootDomain}`}
            />
            {handleEditable ? (
              <Notice
                tone="info"
                className="border-transparent bg-[var(--surface-active)]"
              >
                <span className="font-medium text-[var(--content-tertiary)]">
                  {t("assistantInboxSetupCard.immutableNotice")}
                </span>
              </Notice>
            ) : null}
          </div>
        </InboxCard>
      </div>
    </AssistantInboxShell>
  );
}
