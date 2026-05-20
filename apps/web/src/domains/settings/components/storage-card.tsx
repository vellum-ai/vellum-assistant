import { Loader2 } from "lucide-react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { Typography } from "@vellum/design-library/components/typography";
import {
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";

/**
 * The storage-create endpoint is not yet in the public OpenAPI spec.
 * Use a manual fetch until the spec is updated.
 */
async function applyOnboardingStorage(): Promise<{ failures: number }> {
  const res = await fetch(
    "/api/v1/organizations/billing/subscription/onboarding/storage",
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw body;
  }
  return res.json() as Promise<{ failures: number }>;
}

// Mirrors backend PRO_STORAGE_TIERS — TODO: surface storage_gib in onboarding
// state response to avoid drift.
const STORAGE_TIER_GIB: Record<string, number> = {
  xs: 10,
  s: 30,
  m: 60,
  l: 120,
  xl: 250,
  xxl: 500,
};

const GENERIC_ERROR_MESSAGE = "Could not apply storage. Please try again.";
const MISSING_TIER_MESSAGE =
  "Your Pro plan is missing a storage tier. Please contact support.";

function StorageHeading() {
  return (
    <Typography as="h2" variant="title-medium">
      Storage
    </Typography>
  );
}

export function StorageCard() {
  const queryClient = useQueryClient();
  const subscriptionQuery = useQuery(
    organizationsBillingSubscriptionRetrieveOptions(),
  );
  const isPro = subscriptionQuery.data?.plan_id === "pro";
  // Endpoint is Pro-only; skip until plan resolves.
  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: isPro,
  });
  const applyMutation = useMutation({
    mutationFn: applyOnboardingStorage,
    onSuccess: ({ failures }) => {
      if (failures === 0) {
        toast.success("Storage applied.");
      } else {
        toast.warning(
          `Storage applied with ${failures} failure(s). Try again or contact support.`,
        );
      }
      queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
      });
    },
    onError: (error) => {
      // hey-api types `error` as `Error`, but the backend rejects with a
      // plain JSON body. Widen via `unknown` to narrow into the 409
      // missing-tier discriminator and surface a contact-support hint.
      const body = error as unknown;
      const isMissingTier =
        !!body &&
        typeof body === "object" &&
        (body as Record<string, unknown>).error ===
          "missing_or_invalid_storage_tier";
      toast.error(isMissingTier ? MISSING_TIER_MESSAGE : GENERIC_ERROR_MESSAGE);
    },
  });

  // Subscription error must surface BEFORE the isPro gate — when the
  // subscription fetch fails, `data` is undefined and `isPro` is false, so a
  // Pro user with a transient subscription failure would otherwise see an
  // empty slot instead of an error and lose access to the Apply flow.
  if (subscriptionQuery.isError) {
    return (
      <Card padding="md">
        <StorageHeading />
        <Notice tone="warning" className="mt-3">
          Could not load subscription. Try again later.
        </Notice>
      </Card>
    );
  }
  // While the subscription is still loading, render nothing — the card just
  // doesn't appear yet. Once it resolves to non-Pro, also stay hidden.
  if (!isPro) {
    return null;
  }

  if (onboardingQuery.isLoading) {
    return (
      <Card padding="md">
        <StorageHeading />
        <div className="mt-4 flex items-center gap-2 text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Typography as="span" variant="body-small-default">
            Loading storage configuration...
          </Typography>
        </div>
      </Card>
    );
  }

  if (onboardingQuery.isError) {
    return (
      <Card padding="md">
        <StorageHeading />
        <Notice tone="warning" className="mt-3">
          Could not load storage status. Try again later.
        </Notice>
      </Card>
    );
  }

  const selectedTier = onboardingQuery.data?.selected_storage_tier ?? "";
  const targetGib = STORAGE_TIER_GIB[selectedTier] ?? 0;
  const pvcReady = onboardingQuery.data?.pvc_ready;

  return (
    <Card padding="md">
      <StorageHeading />
      <Typography
        as="p"
        variant="body-small-default"
        className="mt-2 text-[var(--content-tertiary)]"
      >
        Your Pro plan includes {targetGib} GiB of workspace storage.
      </Typography>
      {pvcReady === false && (
        <Notice tone="warning" className="mt-3">
          Your workspace storage is still being set up.
        </Notice>
      )}
      <Button
        variant="outlined"
        onClick={() => applyMutation.mutate()}
        disabled={applyMutation.isPending}
        className="mt-4"
      >
        {applyMutation.isPending
          ? "Applying…"
          : "Apply Storage to All Assistants"}
      </Button>
    </Card>
  );
}
