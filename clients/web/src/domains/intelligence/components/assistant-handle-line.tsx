import { Pencil } from "lucide-react";

import { cn } from "@vellumai/design-library";

import { useAssistantHandleModal } from "@/components/assistant-handle-modal";
import { useTranslation } from "@/i18n";

export interface AssistantHandleLineViewProps {
  handle: string;
  onEdit: () => void;
  /** Keep the line's space but show nothing, while the greeting is borrowed. */
  hidden?: boolean;
}

/**
 * `@handle` under the assistant page's greeting: the public name beneath the
 * given one. The whole line is the button, and the pencil beside it shows on
 * hover and keyboard focus to say so; where nothing can hover it is always
 * there, since a touch has no other way to learn the line can be pressed.
 */
export function AssistantHandleLineView({
  handle,
  onEdit,
  hidden = false,
}: AssistantHandleLineViewProps) {
  const { t } = useTranslation("intelligence");
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={t("assistantHandleLine.edit", { handle })}
      title={t("assistantHandleLine.editTitle")}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden || undefined}
      className={cn(
        /* The leading pad is the pencil's width and gap, so the handle itself
           stays on the greeting's axis whether or not the pencil shows. */
        "group/handle inline-flex cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-[26px]",
        /* Sized against the headline above it, not the body scale: large
           enough to read as the second line of the name, small enough to stay
           its footnote. It steps down where the headline does. */
        "text-[1.125rem] leading-snug max-sm:text-body-large-lighter text-[var(--content-tertiary)]",
        "transition-colors duration-150 hover:text-[var(--content-default)]",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        hidden && "invisible",
      )}
    >
      <span>@{handle}</span>
      <Pencil
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 opacity-0 transition-opacity duration-150",
          "group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100",
          "[@media(hover:none)]:opacity-100",
        )}
      />
    </button>
  );
}

/**
 * The handle line for the active assistant, with the modal it opens. Renders
 * nothing when the assistant has no handle this user can edit here (not
 * platform-hosted, or the platform's listing has not arrived), so the
 * greeting stands alone exactly as it did.
 */
export function AssistantHandleLine({
  assistantId,
  hidden,
}: {
  assistantId: string;
  hidden?: boolean;
}) {
  const { handle, openModal, modal } = useAssistantHandleModal(assistantId);
  if (!handle || !openModal) {
    return null;
  }
  return (
    <>
      <AssistantHandleLineView
        handle={handle}
        onEdit={openModal}
        hidden={hidden}
      />
      {modal}
    </>
  );
}
