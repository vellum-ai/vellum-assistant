import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import { useTranslation } from "@/i18n";

import { organizationsBillingSubscriptionChangePackageCreateMutation } from "@/generated/api/@tanstack/react-query.gen";
import type { PackageChangeResponse } from "@/generated/api/types.gen";

import { invalidateBillingQueries } from "@/domains/settings/billing/invalidate-billing-queries";
import { extractMutationError } from "@/domains/settings/components/adjust-plan-utils";

/**
 * Shared wiring for the change-package CTAs (plan-card banner, plans page).
 * Posts `{ package }` to the change-package endpoint, runs the shared
 * billing invalidation on success, and surfaces the extracted error
 * (including a 402 declined-card message) as a toast on failure.
 */
export function useChangePackage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("settings");
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
      await invalidateBillingQueries(queryClient);
      return result;
    } catch (error) {
      toast.error(
        extractMutationError(error, t("customPlanModal.changeFailed")),
      );
      return null;
    }
  };

  return { changePackage, isPending: mutation.isPending };
}
