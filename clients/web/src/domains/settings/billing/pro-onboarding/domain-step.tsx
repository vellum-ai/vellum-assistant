import { useEffect, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
    assistantsDomainsListQueryKey,
    assistantsListQueryKey,
    organizationsBillingSubscriptionOnboardingDomainCreateMutation,
    organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { useEnvironmentStore } from "@/stores/environment-store";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";

import type { StalledApplyAction } from "./primitives";
import {
    CreatureCorners,
    StalledApplyControls,
    SUBTLE_NOTICE_CLASS,
    WizardCardHeading,
} from "./primitives";
import { useAssistantDomains } from "./use-assistant-domains";
import { DOMAIN_EXIT_DELAY_MS, extractOnboardingErrorMessage } from "./utils";

const FIELD_CLASSES =
  "h-8 rounded-lg border border-[var(--border-element)] bg-[var(--field-bg)] px-2.5 text-[14px] text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-[border-color] duration-150 focus:border-[var(--border-active)] disabled:cursor-not-allowed disabled:opacity-60";
const LABEL_CLASSES = "text-[11px] font-medium text-[var(--content-secondary)]";

export function DomainStep({
  onExit,
  machineBusy = false,
  stalledAction,
  assistantId: preferredAssistantId,
}: {
  onExit: () => void;
  /** The assistant machine is restarting (webhook-driven resize in flight). */
  machineBusy?: boolean;
  /** Set only while the resize is stalled — offers the manual apply here. */
  stalledAction?: StalledApplyAction;
  /** The provisioning target assistant (onboarding primary, else active). */
  assistantId?: string | null;
}) {
  const queryClient = useQueryClient();
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const { assistant, assistantId, domains } = useAssistantDomains(
    true,
    preferredAssistantId,
  );
  const existingDomain = domains?.results[0];

  const [subdomain, setSubdomain] = useState("");
  const [emailUsername, setEmailUsername] = useState("hi");
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (prefilled) return;
    if (existingDomain) {
      setSubdomain(existingDomain.subdomain);
      setPrefilled(true);
      return;
    }
    if (!assistant?.handle || subdomain) {
      return;
    }
    setSubdomain(assistant.handle);
    setPrefilled(true);
  }, [assistant?.handle, existingDomain, prefilled, subdomain]);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const domainMutation = useMutation(
    organizationsBillingSubscriptionOnboardingDomainCreateMutation(),
  );

  const isLocked = !!existingDomain || confirmed;
  const busy = domainMutation.isPending || confirmed;

  useEffect(() => {
    if (!confirmed) return;
    const t = setTimeout(onExit, DOMAIN_EXIT_DELAY_MS);
    return () => clearTimeout(t);
  }, [confirmed, onExit]);

  const handleSet = () => {
    // Registering the email writes to the machine's gateway over the guardian
    // channel, so it must wait until the machine is back online.
    if (busy || machineBusy || !subdomain) return;
    domainMutation.mutate(
      {
        body: {
          subdomain,
          ...(emailUsername ? { email_username: emailUsername } : {}),
        },
      },
      {
        onSuccess: () => {
          setErrorMsg(null);
          setConfirmed(true);
          void queryClient.invalidateQueries({ queryKey: assistantsListQueryKey() });
          void queryClient.invalidateQueries({
            queryKey: assistantsDomainsListQueryKey({
              path: { assistant_id: assistantId ?? "" },
            }),
          });
          void queryClient.invalidateQueries({
            queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
          });
        },
        onError: (err) => {
          setErrorMsg(
            extractOnboardingErrorMessage(
              err,
              "Couldn't register that subdomain. Try a different one.",
            ),
          );
        },
      },
    );
  };

  const handleSkip = () => {
    if (busy) return;
    domainMutation.mutate(
      { body: { skipped: true } },
      { onSuccess: onExit, onError: () => onExit() },
    );
  };

  return (
    <>
      {/* `pb-0` + the footer's `pt-6` give the mock's 24px gap to the actions.
          The creature layer leads so `space-y-6` can't hang a trailing margin
          off the last flowing child. */}
      <Modal.Body className="animate-[onboarding-step-in_350ms_ease-out] space-y-6 pb-0 motion-reduce:animate-none">
        <CreatureCorners variant="top" />
        <WizardCardHeading
          title="Assistant Email"
          subtitle="Set up an email for your assistant."
        />

        <div className="space-y-1.5">
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="onboarding-email-prefix" className={LABEL_CLASSES}>
                Prefix
              </label>
              <input
                id="onboarding-email-prefix"
                value={emailUsername}
                onChange={(e) =>
                  setEmailUsername(e.target.value.toLowerCase().trim())
                }
                disabled={busy || isLocked}
                readOnly={isLocked}
                placeholder="hi"
                className={`${FIELD_CLASSES} w-24`}
              />
            </div>
            <span className="flex h-8 items-center text-[var(--content-secondary)]">
              @
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor="onboarding-email-handle" className={LABEL_CLASSES}>
                Handle (public)
              </label>
              <input
                id="onboarding-email-handle"
                value={subdomain}
                onChange={(e) => {
                  setSubdomain(e.target.value.toLowerCase().trim());
                  if (errorMsg) setErrorMsg(null);
                }}
                disabled={busy || isLocked}
                readOnly={isLocked}
                autoFocus
                placeholder="my-assistant"
                aria-invalid={!!errorMsg}
                className={`${FIELD_CLASSES} w-full min-w-0`}
              />
            </div>
            <span className="flex h-8 shrink-0 items-center text-[14px] text-[var(--content-tertiary)]">
              .{emailRootDomain}
            </span>
          </div>
          {errorMsg && (
            <p className="text-body-small-default text-[var(--system-negative-strong)]">
              {errorMsg}
            </p>
          )}
          {isLocked && (
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              This domain has been set and cannot be changed.
            </p>
          )}
        </div>

        {stalledAction && !isLocked ? (
          <StalledApplyControls
            action={stalledAction}
            buttonTestId="domain-stalled-apply"
          />
        ) : (
          machineBusy &&
          !isLocked && (
            <Notice tone="neutral">
              Your assistant is restarting — you can set the domain in a
              moment.
            </Notice>
          )
        )}
        {!isLocked && (
          <Notice tone="info" className={SUBTLE_NOTICE_CLASS}>
            <span className="font-medium">
              You won&apos;t be able to change the handle once set.
            </span>
          </Notice>
        )}
        {confirmed ? (
          <Notice tone="success">Domain set — redirecting…</Notice>
        ) : null}
      </Modal.Body>
      <Modal.Footer className="items-center pt-6">
        {isLocked ? (
          <Button
            variant="primary"
            data-testid="onboarding-domain-continue"
            onClick={onExit}
          >
            Continue
          </Button>
        ) : (
          <>
            <Button
              variant="outlined"
              data-testid="onboarding-domain-skip"
              disabled={busy}
              onClick={handleSkip}
            >
              Skip
            </Button>
            <Button
              variant="primary"
              data-testid="onboarding-domain-set"
              disabled={!subdomain || busy || machineBusy}
              onClick={handleSet}
            >
              Next
            </Button>
          </>
        )}
      </Modal.Footer>
    </>
  );
}
