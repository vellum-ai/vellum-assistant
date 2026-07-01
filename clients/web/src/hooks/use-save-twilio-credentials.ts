import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { channelsReadinessGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { integrationsTwilioCredentialsPost } from "@/generated/daemon/sdk.gen";

interface UseSaveTwilioCredentialsOptions {
  assistantId: string;
  onSuccess?: () => void;
}

/**
 * Shared mutation for saving Twilio credentials (Account SID + Auth Token).
 * Invalidates channel readiness on settle so all consumers see fresh state.
 */
export function useSaveTwilioCredentials({
  assistantId,
  onSuccess,
}: UseSaveTwilioCredentialsOptions) {
  const queryClient = useQueryClient();
  const readinessQueryKey = useMemo(
    () => channelsReadinessGetQueryKey({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  return useMutation({
    mutationFn: ({
      accountSid,
      authToken,
    }: {
      accountSid: string;
      authToken: string;
    }) => {
      if (!accountSid.trim()) {
        throw new Error("Account SID is required.");
      }
      if (!authToken.trim()) {
        throw new Error("Auth Token is required.");
      }
      return integrationsTwilioCredentialsPost({
        path: { assistant_id: assistantId },
        body: { accountSid: accountSid.trim(), authToken: authToken.trim() },
        throwOnError: true,
      });
    },
    onSuccess,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: readinessQueryKey });
    },
  });
}
