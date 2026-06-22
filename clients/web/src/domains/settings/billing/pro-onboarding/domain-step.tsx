import { ArrowLeft, Mail } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    assistantsActiveRetrieveOptions,
    assistantsDomainsListOptions,
    assistantsListQueryKey,
    organizationsBillingSubscriptionOnboardingDomainCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import { useEnvironmentStore } from "@/stores/environment-store";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import { DomainField } from "@/domains/settings/components/domain-field";
import { IconBadge, StepDots } from "./primitives";
import { DOMAIN_EXIT_DELAY_MS, extractOnboardingErrorMessage } from "./utils";

export function DomainStep({ onBack, onExit }: { onBack: () => void; onExit: () => void }) {
  const queryClient = useQueryClient();
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const { data: activeAssistant } = useQuery(assistantsActiveRetrieveOptions());
  const assistantId = activeAssistant?.id;

  const { data: domainsData } = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
  });
  const existingDomain = domainsData?.results?.[0];

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
    if (busy || !subdomain) return;
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
      <Modal.Body
        className="min-h-[320px] space-y-5 pt-10 pb-4"
        style={{ animation: "onboarding-step-in 350ms ease-out" }}
      >
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
      <Modal.Footer className="relative items-center justify-between">
        <Button
          variant="ghost"
          data-testid="onboarding-domain-back"
          disabled={busy}
          onClick={onBack}
          leftIcon={<ArrowLeft className="h-4 w-4" />}
        >
          Back
        </Button>
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          <StepDots current={0} />
        </div>
        <div className="flex items-center gap-2">
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
                disabled={!subdomain || busy}
                onClick={handleSet}
              >
                Set domain
              </Button>
            </>
          )}
        </div>
      </Modal.Footer>
    </>
  );
}
