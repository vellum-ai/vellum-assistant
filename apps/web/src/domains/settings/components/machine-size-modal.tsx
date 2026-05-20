import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Modal } from "@vellum/design-library/components/modal";
import { Notice } from "@vellum/design-library/components/notice";
import { Radio, RadioGroup } from "@vellum/design-library/components/radio";
import { toast } from "@vellum/design-library/components/toast";
import { Typography } from "@vellum/design-library/components/typography";
import {
  organizationsBillingSubscriptionOnboardingMachineCreateMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { MachineSizeEnum } from "@/generated/api/types.gen.js";

/**
 * Pro tier ceilings → machine sizes the org may run at within that tier.
 * Keys mirror `BillingAccount.max_machine_tier` ("medium" | "large" | "xl");
 * values are `MachineSizeEnum` strings sent to the resize mutation.
 */
const TIER_TO_SIZES: Record<string, MachineSizeEnum[]> = {
  medium: ["small", "medium"],
  large: ["small", "medium", "large"],
  xl: ["small", "medium", "large", "extra_large"],
};

const SIZE_LABEL: Record<MachineSizeEnum, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  extra_large: "Extra Large",
};

// Descriptions reflect the cpu_limit / memory_limit from
// `MACHINE_SIZE_RESOURCE_PRESETS` in `django/app/domain_models/constants.py`,
// rounded to integers where the underlying value is a whole number of cores
// (e.g. small's 2000m CPU limit displays as 2 vCPU). Keep these in sync if
// the backend presets change.
const SIZE_DESCRIPTION: Record<MachineSizeEnum, string> = {
  small: "2 vCPU, 3 GiB",
  medium: "2.5 vCPU, 5 GiB",
  large: "4 vCPU, 8 GiB",
  extra_large: "4 vCPU, 16 GiB",
};

const DRF_FIELD_KEYS = ["machine_size", "non_field_errors"] as const;

function extractMutationError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    for (const key of DRF_FIELD_KEYS) {
      const msgs = rec[key];
      if (Array.isArray(msgs) && typeof msgs[0] === "string") {
        return msgs[0];
      }
    }
    if (typeof rec.detail === "string") return rec.detail;
  }
  return fallback;
}

export interface MachineSizeModalProps {
  open: boolean;
  onClose: () => void;
}

export function MachineSizeModal({ open, onClose }: MachineSizeModalProps) {
  // Mirrors the AdjustPlanModal pattern: the modal owns its own data fetch
  // rather than receiving it as a prop. Gating on `enabled: open` keeps the
  // request from firing for closed modals; TanStack dedupes against any
  // already-cached value from `MachineSizeCard`.
  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: open,
  });
  const maxMachineTier = onboardingQuery.data?.max_machine_tier ?? null;
  const allowedSizes: MachineSizeEnum[] =
    (maxMachineTier && TIER_TO_SIZES[maxMachineTier]) || [];

  // `MachineSizeModal` stays mounted on the billing page across open
  // toggles (Radix only unmounts the Dialog.Portal children, not us), so
  // reset the form on close — otherwise a stale fieldError would flash on
  // reopen after a failed Apply.
  const [selected, setSelected] = useState<MachineSizeEnum | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // reset form state on modal close; modal stays mounted across open toggles
      setSelected(null);
      setFieldError(null);
    }
  }, [open]);

  // Fall back to the smallest allowed size until the user picks one (or if
  // the persisted pick is no longer allowed under the current tier).
  const effectiveSelected =
    selected && allowedSizes.includes(selected)
      ? selected
      : allowedSizes[0] ?? null;

  // The dedicated `/subscription/machine/` resize endpoint is still an
  // ATL-591 stub that echoes a canned success response without actually
  // resizing anything. Route Apply through `/subscription/onboarding/machine/`
  // instead — that endpoint already validates `machine_size` against
  // `BillingAccount.max_machine_tier` and runs the real
  // `increase_org_assistant_machine_sizes` convergence. Same request/response
  // shape, so swap the mutation only. Switch back to the dedicated route
  // once ATL-591's real implementation lands.
  const resizeMutation = useMutation(
    organizationsBillingSubscriptionOnboardingMachineCreateMutation(),
  );

  const handleApply = () => {
    if (!effectiveSelected || resizeMutation.isPending) return;
    setFieldError(null);
    resizeMutation.mutate(
      { body: { machine_size: effectiveSelected } },
      {
        onSuccess: (data) => {
          if (data.failures > 0) {
            toast.error(
              `Machine size partially applied: ${data.failures} assistant${
                data.failures === 1 ? "" : "s"
              } failed to resize.`,
              { id: "machine-resize" },
            );
          } else {
            toast.success(
              "Machine size updated. Changes will apply shortly.",
              { id: "machine-resize" },
            );
          }
          onClose();
        },
        onError: (error) => {
          const message = extractMutationError(
            error,
            "Failed to update machine size. Please try again.",
          );
          setFieldError(message);
          toast.error(message, { id: "machine-resize-error" });
        },
      },
    );
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content size="md">
        <Modal.Header>
          <Modal.Title>Configure Machine Size</Modal.Title>
          <Modal.Description className="sr-only">
            Pick a machine size within your Pro tier ceiling. Existing
            assistants larger than the selected size will not be downsized.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          {onboardingQuery.isLoading ? (
            <div className="flex items-center gap-2 text-[var(--content-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <Typography as="span" variant="body-medium-lighter">
                Loading machine configuration...
              </Typography>
            </div>
          ) : onboardingQuery.isError ? (
            <Notice tone="error">
              Failed to load machine configuration.
            </Notice>
          ) : allowedSizes.length === 0 ? (
            <Notice tone="error">
              Your subscription does not have a machine tier configured.
              Contact support if this is unexpected.
            </Notice>
          ) : (
            <div className="space-y-4">
              <Typography
                as="p"
                variant="body-small-default"
                className="text-[var(--content-tertiary)]"
              >
                Increase the machine size for all assistants in your
                organization. Assistants already at or above the selected size
                are left unchanged.
              </Typography>
              <RadioGroup<MachineSizeEnum>
                name="machine-size"
                value={effectiveSelected ?? ("" as MachineSizeEnum)}
                onValueChange={setSelected}
                aria-label="Machine size"
              >
                {allowedSizes.map((size) => {
                  const isChecked = effectiveSelected === size;
                  return (
                    /*
                     * Wrapper handles clicks on helper text and padding, since
                     * Radio's `helperText` renders as a `<span>` rather than a
                     * `<label htmlFor>`. The duplicate `setSelected` call (also
                     * wired via `RadioGroup.onValueChange` when the user lands
                     * on the inner button) is harmless since it's idempotent.
                     */
                    <div
                      key={size}
                      data-testid={`machine-size-option-${size}`}
                      className={[
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                        isChecked
                          ? "border-[var(--border-strong)] bg-[var(--surface-lift)]"
                          : "border-[var(--border-base)] bg-[var(--surface-base)]",
                      ].join(" ")}
                      onClick={() => setSelected(size)}
                    >
                      <Radio<MachineSizeEnum>
                        value={size}
                        label={SIZE_LABEL[size]}
                        helperText={SIZE_DESCRIPTION[size]}
                        className="mt-1"
                      />
                    </div>
                  );
                })}
              </RadioGroup>
              {fieldError && <Notice tone="error">{fieldError}</Notice>}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outlined"
            onClick={onClose}
            data-testid="machine-size-cancel-button"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleApply}
            disabled={
              !effectiveSelected ||
              resizeMutation.isPending ||
              onboardingQuery.isError
            }
            leftIcon={
              resizeMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : undefined
            }
            data-testid="machine-size-apply-button"
          >
            Apply
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
