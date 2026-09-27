import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ChatsSettingsChanges,
  ChatsSettingsLoadState,
  ChatsSettingsModalProps,
} from "@/domains/chat/components/chats-settings-modal";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantCapabilityQuery } from "@/hooks/use-assistant-capability";
import { getOrgHeaderReadiness, useIsOrgReady } from "@/hooks/use-is-org-ready";
import { captureError } from "@/lib/sentry/capture-error";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";

interface UseChatsSettingsOptions {
  assistantId: string;
  open: boolean;
  onSaved: () => void;
}

interface UseChatsSettingsResult {
  state: ChatsSettingsLoadState;
  saveStatus: ChatsSettingsModalProps["saveStatus"];
  save: (changes: ChatsSettingsChanges) => Promise<void>;
  retryLoad: () => void;
}

/** Config query and writes for one assistant-owned modal session. */
export function useChatsSettings({
  assistantId,
  open,
  onSaved,
}: UseChatsSettingsOptions): UseChatsSettingsResult {
  const capability = useAssistantCapabilityQuery("chatsSettings");
  const supported = capability.data === true;
  const orgReady = useIsOrgReady();
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  const saving = useRef(false);
  const [organizationId] = useState(getActiveOrganizationIdForRequests);
  const [loadedForSession, setLoadedForSession] = useState(false);
  const ownsSession = () =>
    mounted.current && getActiveOrganizationIdForRequests() === organizationId;
  const query = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: open && supported && orgReady,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const mutation = useConfigPatchMutation({
    onSuccess: (data, variables) => {
      if (!ownsSession()) {
        return;
      }
      configGetSetQueryData(queryClient, { path: variables.path }, data);
      onSaved();
    },
    onError: (error) => {
      if (ownsSession()) {
        captureError(error, { context: "chats-settings-save" });
      }
    },
  });
  const resetMutation = mutation.reset;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) {
      resetMutation();
    }
  }, [open, resetMutation]);

  const autoArchive = query.data?.conversations?.autoArchive;
  const newMessageEnabled = query.data?.notifications?.newMessageEnabled;
  const validSettings =
    autoArchive != null && typeof newMessageEnabled === "boolean";
  useEffect(() => {
    if (query.isFetchedAfterMount && query.isSuccess && validSettings) {
      setLoadedForSession(true);
    }
  }, [query.isFetchedAfterMount, query.isSuccess, validSettings]);
  let state: ChatsSettingsLoadState;
  if (!orgReady) {
    state = { status: "loading" };
  } else if (!supported && capability.isPending) {
    state = { status: "loading" };
  } else if (!supported && capability.isError) {
    state = { status: "error" };
  } else if (!supported) {
    state = { status: "unsupported" };
  } else if (
    loadedForSession &&
    autoArchive &&
    typeof newMessageEnabled === "boolean"
  ) {
    state = { status: "ready", values: { autoArchive, newMessageEnabled } };
  } else if (
    query.isError ||
    (query.isFetchedAfterMount && query.isSuccess && !validSettings)
  ) {
    state = { status: "error" };
  } else {
    state = { status: "loading" };
  }

  return {
    state,
    saveStatus: mutation.isPending
      ? "pending"
      : mutation.isError
        ? "error"
        : "idle",
    save: async (changes) => {
      if (
        !ownsSession() ||
        !open ||
        !supported ||
        state.status !== "ready" ||
        getOrgHeaderReadiness() !== "ready" ||
        saving.current
      ) {
        return;
      }
      saving.current = true;
      try {
        await mutation.mutateAsync({
          path: { assistant_id: assistantId },
          body: { ...changes },
        });
      } catch {
        // The mutation error keeps the modal's draft available for retry.
      } finally {
        saving.current = false;
      }
    },
    retryLoad: () => {
      if (ownsSession() && orgReady) {
        if (capability.isError || !supported) {
          void capability.refetch();
        }
        if (supported) {
          void query.refetch();
        }
      }
    },
  };
}
