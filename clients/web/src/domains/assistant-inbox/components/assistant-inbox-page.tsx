import { Inbox, Send } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { SegmentControl, cn } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type { InboxEmail, InboxFolder, InboxUsage } from "../types";
import { AssistantInboxHeader } from "./assistant-inbox-header";
import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailDetail } from "./email-detail";
import { EmailList } from "./email-list";

interface FolderEmptyStateProps {
  folder: InboxFolder;
  address: string;
}

function FolderEmptyState({ folder, address }: FolderEmptyStateProps) {
  const { t } = useTranslation("assistant-inbox");
  const Icon = folder === "inbox" ? Inbox : Send;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-[var(--surface-active)]">
        <Icon
          className="size-5 text-[var(--content-tertiary)]"
          aria-hidden="true"
        />
      </span>
      <p className="text-body-medium-default text-[var(--content-default)]">
        {folder === "inbox"
          ? t("assistantInboxPage.inboxEmptyTitle")
          : t("assistantInboxPage.sentEmptyTitle")}
      </p>
      <p className="max-w-xs text-body-small-lighter text-[var(--content-tertiary)]">
        {folder === "inbox"
          ? t("assistantInboxPage.inboxEmptyBody", { address })
          : t("assistantInboxPage.sentEmptyBody")}
      </p>
    </div>
  );
}

export interface AssistantInboxPageProps {
  assistantId: string;
  assistantName: string;
  address: string;
  inbox: InboxEmail[];
  sent: InboxEmail[];
  usage?: InboxUsage;
  /** Injected so fixtures render stable relative times. Defaults to the clock. */
  now?: Date;
  /** The folder to open on. Defaults to the inbox. */
  initialFolder?: InboxFolder;
  /** A message to open on, for a deep link or a story. Must be in `initialFolder`. */
  initialSelectedId?: string | null;
  onAskToReply?: (email: InboxEmail) => void;
}

/**
 * The inbox when the assistant has an address: masthead, a two-way folder
 * switch, and a list beside a reading pane. Below the `md` breakpoint the two
 * panes take turns instead, list first, with a back control on the message.
 * Selection is local; the folder switch clears it so a message from Inbox is
 * never left open over the Sent list.
 */
export function AssistantInboxPage({
  assistantId,
  assistantName,
  address,
  inbox,
  sent,
  usage,
  now,
  initialFolder = "inbox",
  initialSelectedId = null,
  onAskToReply,
}: AssistantInboxPageProps) {
  const { t } = useTranslation("assistant-inbox");
  const [folder, setFolder] = useState<InboxFolder>(initialFolder);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );
  const clock = useMemo(() => now ?? new Date(), [now]);

  const emails = folder === "inbox" ? inbox : sent;
  const selected = emails.find((email) => email.id === selectedId) ?? null;

  const handleFolderChange = useCallback((next: InboxFolder) => {
    setFolder(next);
    setSelectedId(null);
  }, []);

  const unreadCount = inbox.filter((email) => email.unread).length;
  const folderItems = useMemo(
    () => [
      {
        value: "inbox" as const,
        label:
          unreadCount > 0
            ? t("assistantInboxPage.inboxTabUnread", { count: unreadCount })
            : t("assistantInboxPage.inboxTab"),
        icon: <Inbox aria-hidden="true" />,
      },
      {
        value: "sent" as const,
        label: t("assistantInboxPage.sentTab"),
        icon: <Send aria-hidden="true" />,
      },
    ],
    [t, unreadCount],
  );

  return (
    <AssistantInboxShell>
      <AssistantInboxHeader
        assistantId={assistantId}
        address={address}
        usage={usage}
      />

      <div className="flex items-center border-b border-[var(--border-subtle)] px-6 pb-3">
        {/* Two folders need no more room than their labels; a switch that
            spans the pane reads as a tab bar for a page that has none. */}
        <SegmentControl
          items={folderItems}
          value={folder}
          onChange={handleFolderChange}
          ariaLabel={t("assistantInboxPage.folderAriaLabel")}
          className="w-auto min-w-[260px]"
        />
      </div>

      {emails.length === 0 ? (
        <FolderEmptyState folder={folder} address={address} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(280px,360px)_1fr]">
          <EmailList
            emails={emails}
            selectedId={selectedId}
            now={clock}
            onSelect={setSelectedId}
            className={cn(
              "md:border-r md:border-[var(--border-subtle)]",
              selected && "max-md:hidden",
            )}
          />
          {selected ? (
            <EmailDetail
              key={selected.id}
              email={selected}
              assistantName={assistantName}
              onBack={() => setSelectedId(null)}
              onAskToReply={onAskToReply}
            />
          ) : (
            <div className="hidden items-center justify-center p-8 text-body-small-lighter text-[var(--content-tertiary)] md:flex">
              {t("assistantInboxPage.selectPrompt")}
            </div>
          )}
        </div>
      )}
    </AssistantInboxShell>
  );
}
