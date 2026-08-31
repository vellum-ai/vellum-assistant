import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

import { organizationsBillingSubscriptionRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";

import { extractMutationError } from "@/domains/settings/components/adjust-plan-utils";

interface SubscriptionActionConfig<TResult> {
  mutateAsync: () => Promise<TResult>;
  /** Toasts the outcome; runs after the subscription read is invalidated. */
  onSuccess: (result: TResult) => void;
  errorToastId: string;
  errorFallback: () => string;
}

/**
 * Common pipeline for the direct subscription actions (cancel, reactivate):
 * post the endpoint, invalidate the subscription read so the changed
 * `cancel_at_period_end` / `cancel_at` state surfaces everywhere, hand the
 * result to the action's success toast, and toast + resolve null on error so
 * the calling UI can stay open for a retry.
 */
export function useSubscriptionAction() {
  const queryClient = useQueryClient();

  return async <TResult>(
    config: SubscriptionActionConfig<TResult>,
  ): Promise<TResult | null> => {
    try {
      const result = await config.mutateAsync();
      await queryClient.invalidateQueries({
        queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
      });
      config.onSuccess(result);
      return result;
    } catch (error) {
      toast.error(extractMutationError(error, config.errorFallback()), {
        id: config.errorToastId,
      });
      return null;
    }
  };
}
