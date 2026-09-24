import { EmailReferenceCard } from "@/domains/chat/components/chat-attachments/email-reference-card";
import type { EmailReference } from "@/types/email-reference";

export interface MessageEmailReferencesProps {
  emails: EmailReference[];
}

/**
 * The emails a sent message carried, stacked in the bubble the way
 * {@link BubbleAttachments} stacks files. Uncapped, like that surface: the
 * user picked every one of them.
 */
export function MessageEmailReferences({
  emails,
}: MessageEmailReferencesProps) {
  if (emails.length === 0) {
    return null;
  }
  return (
    <div data-testid="message-email-references" className="flex flex-col gap-2">
      {emails.map((email) => (
        <EmailReferenceCard key={email.id} email={email} />
      ))}
    </div>
  );
}
