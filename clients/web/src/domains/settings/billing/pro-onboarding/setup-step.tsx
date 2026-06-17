import { ArrowLeft, ArrowRight, Cpu, HardDrive, Server } from "lucide-react";
import { useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";

import {
    assistantsActiveRetrieveOptions,
    assistantsResizeMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { MachineSizeEnum, MachineTierEnum } from "@/generated/api/types.gen";
import {
    SIZE_DESCRIPTION,
    SIZE_LABEL,
} from "@/lib/billing/machine-sizes";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import { IconBadge, StepDots } from "./primitives";
import {
    allowedMachineSizesForTier,
    extractOnboardingErrorMessage,
} from "./utils";

function ResourceCard({
  icon: Icon,
  label,
  from,
  fromDetail,
  to,
  toDetail,
}: {
  icon: typeof Server;
  label: string;
  from: string;
  fromDetail?: string;
  to: string;
  toDetail?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-[var(--surface-base)] p-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: "color-mix(in oklab, var(--system-positive-strong) 10%, transparent)",
        }}
      >
        <Icon className="h-4 w-4 text-[var(--system-positive-strong)]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-label-small-default text-[var(--content-tertiary)]">
          {label}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex flex-col">
            <span className="text-label-medium-default text-[var(--content-tertiary)] line-through">
              {from}
            </span>
            {fromDetail && (
              <span className="text-label-small-default text-[var(--content-tertiary)] line-through">
                {fromDetail}
              </span>
            )}
          </div>
          <ArrowRight className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]" />
          <div className="flex flex-col">
            <span className="text-label-medium-default text-[var(--content-default)]">
              {to}
            </span>
            {toDetail && (
              <span className="text-label-small-default text-[var(--content-tertiary)]">
                {toDetail}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SetupStep({
  storageGib,
  maxTier,
  onBack,
  onAdvance,
  dotIndex,
  dotTotal,
}: {
  storageGib: number | null;
  maxTier: MachineTierEnum | null;
  onBack: () => void;
  onAdvance: () => void;
  dotIndex: number;
  dotTotal: number;
}) {
  const { data: activeAssistant } = useQuery(assistantsActiveRetrieveOptions());
  const currentSize = (activeAssistant?.machine_size as MachineSizeEnum) || "small";
  const currentGib = activeAssistant?.provisioned_storage_gib ?? null;

  const allowedSizes = allowedMachineSizesForTier(maxTier);
  const targetSize: MachineSizeEnum =
    allowedSizes.length > 0 ? allowedSizes[allowedSizes.length - 1] : currentSize;

  const machineChanged = targetSize !== currentSize;
  const canGrowStorage =
    storageGib != null && (currentGib == null || currentGib < storageGib);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const resizeMutation = useMutation(assistantsResizeMutation());

  const handleContinue = () => {
    if (resizeMutation.isPending || !activeAssistant?.id) return;
    resizeMutation.mutate(
      {
        path: { id: activeAssistant.id },
        body: {
          machine_size: targetSize,
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
              Your assistant's new resources
            </Typography>
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              Your assistant will go offline briefly while it resizes.
            </Typography>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {machineChanged && (
            <ResourceCard
              icon={Cpu}
              label="Machine"
              from={SIZE_LABEL[currentSize]}
              fromDetail={SIZE_DESCRIPTION[currentSize]}
              to={SIZE_LABEL[targetSize]}
              toDetail={SIZE_DESCRIPTION[targetSize]}
            />
          )}
          {canGrowStorage && (
            <ResourceCard
              icon={HardDrive}
              label="Storage"
              from={currentGib != null ? `${currentGib} GiB` : "—"}
              to={`${storageGib} GiB`}
            />
          )}
          {!machineChanged && !canGrowStorage && (
            <Notice tone="neutral">
              Your assistant is already running at the maximum size for your plan.
            </Notice>
          )}
        </div>

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
          <StepDots current={dotIndex} total={dotTotal} />
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
            Apply & Restart
          </Button>
        </div>
      </Modal.Footer>
    </>
  );
}
