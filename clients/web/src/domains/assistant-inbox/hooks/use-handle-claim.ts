import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  checkAssistantHandleAvailable,
  HANDLE_ERROR_COPY,
  updateAssistantHandle,
} from "@/domains/account/handle";
import { assistantsListQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";

import type { HandleClaimIo } from "../types";

/**
 * The handle calls for one assistant, through the same endpoints the profile
 * card's handle editor uses. `null` until the platform's id for the assistant
 * is known, which is also how a caller learns there is nothing to offer yet.
 * A save refreshes the assistant listing, since that is where every surface
 * here reads the handle from.
 */
export function useHandleClaim(
  platformAssistantId: string | null,
): HandleClaimIo | null {
  const { t } = useTranslation("assistant-inbox");
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (!platformAssistantId) {
      return null;
    }
    return {
      check: async (handle, signal) => {
        const result = await checkAssistantHandleAvailable(
          platformAssistantId,
          handle,
          signal,
        );
        if (result.available) {
          return { available: true };
        }
        return {
          available: false,
          message:
            result.message ??
            (result.code ? HANDLE_ERROR_COPY[result.code] : null) ??
            t("handleClaim.saveFailed"),
        };
      },
      save: async (handle) => {
        const result = await updateAssistantHandle(platformAssistantId, handle);
        if (result.kind !== "ok") {
          return { ok: false, message: result.message };
        }
        await queryClient.invalidateQueries({
          queryKey: assistantsListQueryKey(),
        });
        return { ok: true };
      },
    };
  }, [platformAssistantId, queryClient, t]);
}
