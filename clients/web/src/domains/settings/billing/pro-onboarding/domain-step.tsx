import { Mail } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    assistantsDomainsListQueryKey,
    assistantsListQueryKey,
    organizationsBillingSubscriptionOnboardingDomainCreateMutation,
    organizationsBillingSubscriptionOnboardingRetrieveOptions,
    organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useEnvironmentStore } from "@/stores/environment-store";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import { DomainField } from "@/domains/settings/components/domain-field";
import type { StalledApplyAction } from "./primitives";
import {
    IconBadge,
    STALLED_UPGRADE_WARNING,
    StalledApplyControls,
} from "./primitives";
import { useAssistantDomains } from "./use-assistant-domains";
import { DOMAIN_EXIT_DELAY_MS, extractOnboardingErrorMessage } from "./utils";

export function DomainStep({
  onExit,
  machineBusy = false,
  stalledAction,
}: {
  onExit: () => void;
  /** The assistant machine is restarting (webhook-driven resize in flight). */
  machineBusy?: boolean;
  /** Set only while the resize is stalled — offers the manual apply here. */
  stalledAction?: StalledApplyAction;
}) {
  const queryClient = useQueryClient();
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const isOrgReady = useIsOrgReady();
  // The onboarding payload names the assistant the domain registration
  // targets server-side; prefer it over the active assistant.
  const { data: onboarding } = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: isOrgReady,
  });
  const { activeAssistant, assistantId, domains } = useAssistantDomains(
    true,
    onboarding?.primary_assistant_id,
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
    if (!activeAssistant?.handle || subdomain) return;
    setSubdomain(activeAssistant.handle);
    setPrefilled(true);
  }, [activeAssistant?.handle, existingDomain, prefilled, subdomain]);

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
      <Modal.Body className="min-h-[320px] animate-[onboarding-step-in_350ms_ease-out] space-y-5 pt-10 pb-4 motion-reduce:animate-none">
        <div className="flex flex-col items-center gap-3 pb-2 text-center">
          <IconBadge icon={Mail} />
          <div className="space-y-2">
            <Typography variant="title-small" as="h1">
              Assistant email
            </Typography>
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              Set up an email address for your assistant.
            </Typography>
          </div>
        </div>

        <div className="space-y-1.5">
          <Typography
            variant="body-small-default"
            as="label"
            className="text-[var(--content-secondary)]"
          >
            Email address
          </Typography>
          <DomainField
            subdomain={subdomain}
            autoFocus
            onSubdomainChange={(v) => {
              setSubdomain(v);
              if (errorMsg) setErrorMsg(null);
            }}
            domainSuffix={emailRootDomain}
            disabled={busy}
            error={errorMsg}
            locked={isLocked}
            lockedMessage="This domain has been set and cannot be changed."
            prefix={
              <>
                <input
                  value={emailUsername}
                  onChange={(e) => setEmailUsername(e.target.value.toLowerCase().trim())}
                  disabled={busy || isLocked}
                  readOnly={isLocked}
                  placeholder="hi"
                  aria-label="Email username"
                  size={Math.max(emailUsername.length, 2)}
                  className="h-full w-0 min-w-[2ch] flex-none bg-transparent pl-3 pr-1.5 text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ width: `${Math.max(emailUsername.length, 2) + 1.5}ch` }}
                />
                <span className="shrink-0 font-mono text-[var(--content-secondary)]">@</span>
              </>
            }
          />
        </div>

        {stalledAction && !isLocked ? (
          <div className="flex flex-col items-center gap-2">
            <Notice tone="warning" className="w-full text-left">
              {STALLED_UPGRADE_WARNING}
            </Notice>
            <StalledApplyControls
              action={stalledAction}
              buttonVariant="outlined"
              buttonTestId="domain-stalled-apply"
            />
          </div>
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
          <Notice tone="info">
            <span className="font-mono">{subdomain || "<subdomain>"}</span> will also become your assistant&apos;s public handle.
            You won&apos;t be able to change it once set.
          </Notice>
        )}
        {confirmed ? (
          <Notice tone="success">Domain set — redirecting…</Notice>
        ) : null}
      </Modal.Body>
      <Modal.Footer className="items-center">
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
              variant="ghost"
              data-testid="onboarding-domain-skip"
              disabled={busy}
              onClick={handleSkip}
            >
              Do later
            </Button>
            <Button
              variant="primary"
              data-testid="onboarding-domain-set"
              disabled={!subdomain || busy || machineBusy}
              onClick={handleSet}
            >
              Set domain
            </Button>
          </>
        )}
      </Modal.Footer>
    </>
  );
}
