import { ArrowLeft, Globe } from "lucide-react";
import { useEffect, useState } from "react";

import { useMutation } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Input } from "@vellum/design-library/components/input";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Typography } from "@vellum/design-library/components/typography";
import { organizationsBillingSubscriptionOnboardingDomainCreateMutation } from "@/generated/api/@tanstack/react-query.gen.js";
import { useEnvironmentStore } from "@/lib/environment/environment-store.js";

import { IconBadge, StepDots } from "./primitives.js";
import { DOMAIN_EXIT_DELAY_MS, extractOnboardingErrorMessage } from "./utils.js";

export function DomainStep({ onBack, onExit }: { onBack: () => void; onExit: () => void }) {
  const emailRootDomain = useEnvironmentStore.use.emailRootDomain();
  const [subdomain, setSubdomain] = useState("");
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
      { body: { subdomain } },
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
          <IconBadge icon={Globe} />
          <div className="space-y-2">
            <Typography variant="title-small" as="h1">
              Pick a custom subdomain
            </Typography>
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              You&apos;ll be able to email your assistant at{" "}
              <span className="font-mono text-[var(--content-default)]">
                hi@{subdomain || "<subdomain>"}.{emailRootDomain}
              </span>
            </Typography>
          </div>
        </div>

        <div className="flex items-end gap-2">
          <Input
            fullWidth
            value={subdomain}
            onChange={(e) =>
              setSubdomain(e.target.value.toLowerCase().trim())
            }
            disabled={busy}
            placeholder="my-assistant"
            label="Subdomain"
          />
          <Typography
            variant="body-medium-lighter"
            as="span"
            className="mb-2.5 whitespace-nowrap text-[var(--content-secondary)]"
          >
            .{emailRootDomain}
          </Typography>
        </div>

        <Notice tone="info">
          This will also become your assistant&apos;s public handle.
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
