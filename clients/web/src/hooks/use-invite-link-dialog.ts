import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { contactsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";

export interface InviteLinkDialog {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

/**
 * Open/close state for the A2A `GenerateInviteLinkDialog`. Closing refreshes
 * the contacts cache — an invite generated in the dialog may already have
 * been redeemed (creating a contact) by the time it closes.
 */
export function useInviteLinkDialog(assistantId: string): InviteLinkDialog {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    void queryClient.invalidateQueries({
      queryKey: contactsGetQueryKey({ path: { assistant_id: assistantId } }),
    });
  }, [queryClient, assistantId]);

  return { isOpen, open, close };
}
