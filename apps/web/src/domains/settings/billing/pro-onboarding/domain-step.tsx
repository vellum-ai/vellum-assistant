import { ArrowLeft, Mail } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Typography } from "@vellum/design-library/components/typography";
import {
  assistantsActiveRetrieveOptions,
  organizationsBillingSubscriptionOnboardingDomainCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { useEnvironmentStore } from "@/lib/environment/environment-store.js";

import { IconBadge, StepDots } from "./primitives.js";
import { DOMAIN_EXIT_DELAY_MS, extractOnboardingErrorMessage } from "./utils.js";

export function DomainStep({ onBack, onExit }: { onBack: () => void; onExit: () => void }) {
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const { data: activeAssistant } = useQuery(assistantsActiveRetrieveOptions());
  const [subdomain, setSubdomain] = useState("");
  const [emailUsername, setEmailUsername] = useState("hi");
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (prefilled || !activeAssistant?.handle || subdomain) return;
    setSubdomain(activeAssistant.handle);
    setPrefilled(true);
  }, [activeAssistant?.handle, prefilled, subdomain]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const domainMutation = useMutation(
    organizationsBillingSubscriptionOnboardingDomainCreateMutation(),
  );

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
          <div
            className="flex h-9 w-full items-center rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] text-body-medium-lighter transition-[border-color] duration-150 focus-within:border-[var(--border-active)]"
          >
            <input
              value={emailUsername}
              onChange={(e) => setEmailUsername(e.target.value.toLowerCase().trim())}
              disabled={busy}
              placeholder="hi"
              aria-label="Email username"
              size={Math.max(emailUsername.length, 2)}
              className="h-full w-0 min-w-[2ch] flex-none bg-transparent pl-3 pr-1.5 text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ width: `${Math.max(emailUsername.length, 2) + 1.5}ch` }}
            />
            <span className="shrink-0 font-mono text-[var(--content-secondary)]">@</span>
            <input
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value.toLowerCase().trim())}
              disabled={busy}
              placeholder="my-assistant"
              aria-label="Subdomain"
              className="h-full min-w-0 flex-1 bg-transparent pl-1.5 pr-1 text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
            <span className="shrink-0 pr-3 font-mono text-[var(--content-secondary)]">.{emailRootDomain}</span>
          </div>
        </div>

        <Notice tone="info">
          <span className="font-mono">{subdomain || "<subdomain>"}</span> will also become your assistant&apos;s public handle.
          You won&apos;t be able to change it once set.
        </Notice>

        {errorMsg ? <Notice tone="error">{errorMsg}</Notice> : null}
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
          <StepDots current={1} />
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </Modal.Footer>
    </>
  );
}
