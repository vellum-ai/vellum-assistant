/**
 * A `recall` evidence item found in a conversation, as a `ListRow` that opens
 * the conversation at the matching message. It is a real link, so a modified
 * or middle click still opens it in a new tab; a plain click navigates in the
 * app through `navigateToConversation`, which leaves the current conversation
 * the way every other switch does.
 */

import { ListRow } from "@vellumai/design-library";
import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { navigateToConversation } from "@/utils/conversation-navigation";
import { isModifiedLinkClick } from "@/utils/link-click";
import { routes } from "@/utils/routes";

interface RecallConversationRowProps {
  conversationId: string;
  /** The matching message, when recall knows it. */
  messageId?: string;
  title: string;
  subtitle?: string;
  trailing: ReactNode;
}

export function RecallConversationRow({
  conversationId,
  messageId,
  title,
  subtitle,
  trailing,
}: RecallConversationRowProps) {
  const navigate = useNavigate();
  return (
    <ListRow
      role="listitem"
      leading={
        <MessageSquare
          className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
          aria-hidden
        />
      }
      title={title}
      subtitle={subtitle}
      trailing={trailing}
      href={
        messageId
          ? routes.conversationAtMessage(conversationId, messageId)
          : routes.conversation(conversationId)
      }
      onClick={(event) => {
        if (isModifiedLinkClick(event)) {
          return;
        }
        event.preventDefault();
        navigateToConversation(
          navigate,
          conversationId,
          messageId ? { messageId } : undefined,
        );
      }}
    />
  );
}
