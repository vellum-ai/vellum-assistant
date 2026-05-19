import { describe, expect, mock, test } from "bun:test";

import { createWebSyncRouter } from "@/lib/sync/web-sync-router.js";
import {
  conversationMessagesSyncTag,
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "@/lib/sync/types.js";

const REFRESH_RESULT = {
  changed: false,
  messagesAdded: 0,
  assistantProgress: false,
};

describe("createWebSyncRouter", () => {
  test("routes live assistant and conversation sync tags", async () => {
    const activeConversationKeyRef = { current: "conv-1" };
    const invalidateAvatar = mock(() => {});
    const refreshAssistantIdentity = mock(async () => {});
    const invalidateAssistantConfig = mock(() => {});
    const invalidateAssistantSounds = mock(() => {});
    const invalidateAssistantSchedules = mock(() => {});
    const scheduleConversationListRefetch = mock(() => {});
    const refreshActiveConversationMessages = mock(async () => REFRESH_RESULT);
    const router = createWebSyncRouter({
      activeConversationKeyRef,
      invalidateAvatar,
      refreshAssistantIdentity,
      invalidateAssistantConfig,
      invalidateAssistantSounds,
      invalidateAssistantSchedules,
      scheduleConversationListRefetch,
      refreshActiveConversationMessages,
    });

    try {
      const result = await router.dispatchSyncChanged({
        type: "sync_changed",
        tags: [
          SYNC_TAGS.assistantAvatar,
          SYNC_TAGS.assistantIdentity,
          SYNC_TAGS.assistantConfig,
          SYNC_TAGS.assistantSounds,
          SYNC_TAGS.assistantSchedules,
          SYNC_TAGS.conversationsList,
          conversationMetadataSyncTag("conv-1"),
          conversationMetadataSyncTag("conv-2"),
          conversationMessagesSyncTag("conv-1"),
          conversationMessagesSyncTag("conv-2"),
        ],
      });

      expect(invalidateAvatar).toHaveBeenCalledTimes(1);
      expect(refreshAssistantIdentity).toHaveBeenCalledWith(true);
      expect(invalidateAssistantConfig).toHaveBeenCalledTimes(1);
      expect(invalidateAssistantSounds).toHaveBeenCalledTimes(1);
      expect(invalidateAssistantSchedules).toHaveBeenCalledTimes(1);
      expect(scheduleConversationListRefetch).toHaveBeenCalledTimes(5);
      expect(refreshActiveConversationMessages).toHaveBeenCalledTimes(1);
      expect(result.unknownTags).toEqual([]);
    } finally {
      router.dispose();
    }
  });

  test("reconnect broadly refreshes mounted sync-scoped resources", async () => {
    const activeConversationKeyRef = { current: "conv-1" };
    const invalidateAvatar = mock(() => {});
    const refreshAssistantIdentity = mock(async () => {});
    const invalidateAssistantConfig = mock(() => {});
    const invalidateAssistantSounds = mock(() => {});
    const invalidateAssistantSchedules = mock(() => {});
    const scheduleConversationListRefetch = mock(() => {});
    const refreshActiveConversationMessages = mock(async () => ({
      changed: true,
      messagesAdded: 2,
      assistantProgress: true,
    }));
    const router = createWebSyncRouter({
      activeConversationKeyRef,
      invalidateAvatar,
      refreshAssistantIdentity,
      invalidateAssistantConfig,
      invalidateAssistantSounds,
      invalidateAssistantSchedules,
      scheduleConversationListRefetch,
      refreshActiveConversationMessages,
    });

    try {
      const result = await router.dispatchReconnect();

      expect(invalidateAvatar).toHaveBeenCalledTimes(1);
      expect(refreshAssistantIdentity).toHaveBeenCalledWith(true);
      expect(invalidateAssistantConfig).toHaveBeenCalledTimes(1);
      expect(invalidateAssistantSounds).toHaveBeenCalledTimes(1);
      expect(invalidateAssistantSchedules).toHaveBeenCalledTimes(1);
      expect(scheduleConversationListRefetch).toHaveBeenCalledTimes(1);
      expect(refreshActiveConversationMessages).toHaveBeenCalledTimes(1);
      expect(result.activeConversationMessages).toEqual({
        changed: true,
        messagesAdded: 2,
        assistantProgress: true,
      });
    } finally {
      router.dispose();
    }
  });
});
