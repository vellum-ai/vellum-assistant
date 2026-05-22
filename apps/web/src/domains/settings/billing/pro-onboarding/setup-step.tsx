import { ArrowLeft, Cpu } from "lucide-react";
import { useMemo, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown, type DropdownOption } from "@vellum/design-library/components/dropdown";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Typography } from "@vellum/design-library/components/typography";
import type { MachineSizeEnum, MachineTierEnum } from "@/generated/api/types.gen.js";
import {
  assistantsActiveRetrieveOptions,
  assistantsResizeMutation,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { SIZE_DESCRIPTION, SIZE_LABEL } from "@/lib/billing/machine-sizes.js";

import { IconBadge, StepDots } from "./primitives.js";
import {
  allowedMachineSizesForTier,
  extractOnboardingErrorMessage,
} from "./utils.js";

export function SetupStep({
  storageGib,
  maxTier,
  onBack,
  onAdvance,
}: {
  storageGib: number | null;
  maxTier: MachineTierEnum | null;
  onBack: () => void;
  onAdvance: () => void;
}) {
  const { data: activeAssistant } = useQuery(assistantsActiveRetrieveOptions());
  const machineSizeOptions = useMemo<DropdownOption<MachineSizeEnum>[]>(
    () =>
      allowedMachineSizesForTier(maxTier).map((size) => ({
        value: size,
        label: `${SIZE_LABEL[size]} — ${SIZE_DESCRIPTION[size]}`,
      })),
    [maxTier],
  );
  const [selectedSize, setSelectedSize] = useState<MachineSizeEnum>(
    machineSizeOptions[0]?.value ?? "small",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const resizeMutation = useMutation(assistantsResizeMutation());

  const handleContinue = () => {
    if (resizeMutation.isPending || !activeAssistant?.id) return;
    resizeMutation.mutate(
      {
        path: { id: activeAssistant.id },
        body: {
          machine_size: selectedSize,
          ...(storageGib != null ? { storage_gib: storageGib } : {}),
        },
      },
      {
        onSuccess: () => {
          setErrorMsg(null);
          onAdvance();
        },
        onError: (err) => {
          setErrorMsg(
            extractOnboardingErrorMessage(
              err,
              "Couldn't apply changes. Please try again.",
            ),
          );
        },
      },
    );
  };

  const description = storageGib != null
    ? `Pick a machine size and we'll apply your ${storageGib} GiB of included storage.`
    : "Pick a machine size for your assistant.";

  return (
    <>
      <Modal.Body
        className="min-h-[320px] space-y-5 pt-10 pb-4"
        style={{ animation: "onboarding-step-in 350ms ease-out" }}
      >
        <div className="flex flex-col items-center gap-3 pb-2 text-center">
          <IconBadge icon={Cpu} />
          <div className="space-y-2">
            <Typography variant="title-small" as="h1">
              Choose your compute
            </Typography>
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {description}
            </Typography>
          </div>
        </div>

        <div className="space-y-1">
          <Typography
            variant="label-small-default"
            as="label"
            className="text-[var(--content-secondary)]"
          >
            Machine size
          </Typography>
          <Dropdown
            options={machineSizeOptions}
            value={selectedSize}
            onChange={setSelectedSize}
            aria-label="Machine size"
            data-testid="onboarding-machine-size"
          />
        </div>

        <Notice tone="info">Your assistant will go offline briefly while it resizes.</Notice>

        {errorMsg ? <Notice tone="error">{errorMsg}</Notice> : null}
      </Modal.Body>
      <Modal.Footer className="relative items-center justify-between">
        <Button
          variant="ghost"
          data-testid="onboarding-setup-back"
          disabled={resizeMutation.isPending}
          onClick={onBack}
          leftIcon={<ArrowLeft className="h-4 w-4" />}
        >
          Back
        </Button>
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          <StepDots current={0} />
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            data-testid="onboarding-setup-skip"
            disabled={resizeMutation.isPending}
            onClick={onAdvance}
          >
            Do later
          </Button>
          <Button
            variant="primary"
            data-testid="onboarding-setup-continue"
            disabled={resizeMutation.isPending || !activeAssistant?.id}
            onClick={handleContinue}
          >
            Continue
          </Button>
        </div>
      </Modal.Footer>
    </>
  );
}
