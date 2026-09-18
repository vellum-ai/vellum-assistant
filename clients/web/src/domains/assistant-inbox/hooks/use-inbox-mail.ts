import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { z } from "zod";

import {
  assistantsEmailAddressesStatusRetrieveOptions,
  assistantsEmailsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import {
  emailAttachmentlistGet,
  emailDownloadGet,
} from "@/generated/daemon/sdk.gen";

import {
  mapAttachment,
  mapEmailMessage,
  toDetailData,
} from "../map-email-message";
import type { EmailDetailLoader, InboxEmail, InboxUsage } from "../types";

/** As many as the list shows before paging would be worth building. */
const PAGE_SIZE = 50;

/**
 * The daemon's `email/download` route returns the platform's message
 * object untyped; only the two body parts are read here, and a shape drift
 * reads as an empty body rather than a crash.
 */
const DownloadSchema = z.object({
  body_text: z.string().nullable().optional(),
  body_html: z.string().nullable().optional(),
});

const AttachmentListSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      filename: z.string(),
      content_type: z.string(),
      size_bytes: z.number(),
    }),
  ),
});

export interface InboxMail {
  received: InboxEmail[];
  sent: InboxEmail[];
  usage: InboxUsage | undefined;
  isLoading: boolean;
  /**
   * Either folder's list failed and nothing is cached for it. An empty
   * folder and a failed read are different things, so the page never draws
   * the first for the second.
   */
  isError: boolean;
  /** Re-run whichever list reads failed. */
  retry: () => void;
  loadDetail: EmailDetailLoader;
}

/**
 * The mail the mailbox draws. The two folders come from the platform, keyed
 * on the platform assistant id, and the usage counts from the address's own
 * status endpoint. The body and attachments
 * of a message come through the daemon, keyed on the local assistant id the
 * daemon routes expect, and only when a message is opened.
 */
export function useInboxMail(
  assistantId: string,
  platformAssistantId: string,
  addressId: string,
): InboxMail {
  const path = { assistant_id: platformAssistantId };

  const receivedQuery = useQuery(
    assistantsEmailsListOptions({
      path,
      query: { direction: "inbound", limit: PAGE_SIZE },
    }),
  );
  const sentQuery = useQuery(
    assistantsEmailsListOptions({
      path,
      query: { direction: "outbound", limit: PAGE_SIZE },
    }),
  );
  const usageQuery = useQuery(
    assistantsEmailAddressesStatusRetrieveOptions({
      path: { ...path, id: addressId },
    }),
  );

  const received = useMemo(
    () => (receivedQuery.data?.results ?? []).map(mapEmailMessage),
    [receivedQuery.data],
  );
  const sent = useMemo(
    () => (sentQuery.data?.results ?? []).map(mapEmailMessage),
    [sentQuery.data],
  );
  const usage = useMemo<InboxUsage | undefined>(() => {
    const raw = usageQuery.data?.usage;
    return raw
      ? {
          sentToday: raw.sent_today,
          receivedToday: raw.received_today,
          dailyLimit: raw.daily_limit,
        }
      : undefined;
  }, [usageQuery.data]);

  const loadDetail = useCallback<EmailDetailLoader>(
    async (email) => {
      const [download, attachments] = await Promise.all([
        emailDownloadGet({
          path: { assistant_id: assistantId },
          query: { messageId: email.id },
          throwOnError: true,
        }),
        emailAttachmentlistGet({
          path: { assistant_id: assistantId },
          query: { messageId: email.id },
          throwOnError: true,
        }),
      ]);
      const parts = DownloadSchema.safeParse(download.data);
      const list = AttachmentListSchema.safeParse(attachments.data);
      return toDetailData(
        parts.success ? parts.data : {},
        list.success ? list.data.results.map(mapAttachment) : [],
      );
    },
    [assistantId],
  );

  const retry = useCallback(() => {
    if (receivedQuery.isError) {
      void receivedQuery.refetch();
    }
    if (sentQuery.isError) {
      void sentQuery.refetch();
    }
  }, [receivedQuery, sentQuery]);

  return {
    received,
    sent,
    usage,
    isLoading: receivedQuery.isPending || sentQuery.isPending,
    isError:
      (receivedQuery.isError && receivedQuery.data === undefined) ||
      (sentQuery.isError && sentQuery.data === undefined),
    retry,
    loadDetail,
  };
}
