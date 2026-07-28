import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionChangePackageCreateMutation,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { PackageChangeResponse } from "@/generated/api/types.gen";

import { extractMutationError } from "@/domains/settings/components/adjust-plan-utils";

/**
 * Shared wiring for the change-package CTAs (plan-card banner, plans page).
 * Posts `{ package }` to the change-package endpoint, invalidates the three
 * billing queries on success (mirrors `adjust-plan-modal`'s
 * `invalidateBillingQueries`), and surfaces the extracted error — including a
 * 402 declined-card message — as a toast on failure.
 */
export function useChangePackage() {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    organizationsBillingSubscriptionChangePackageCreateMutation(),
  );

  const changePackage = async (
    packageKey: string,
  ): Promise<PackageChangeResponse | null> => {
    try {
      const result = await mutation.mutateAsync({
        body: { package: packageKey },
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: organizationsBillingPlansRetrieveQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
        }),
      ]);
      return result;
    } catch (error) {
      toast.error(
        extractMutationError(error, "Failed to change your plan. Please try again."),
      );
      return null;
    }
  };

  return { changePackage, isPending: mutation.isPending };
}
