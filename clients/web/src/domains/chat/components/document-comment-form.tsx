import { Button } from "@vellumai/design-library";
import { Send } from "lucide-react";
import { useCallback, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export interface DocumentCommentFormProps {
  onSubmit: (content: string) => Promise<void>;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Simple textarea + submit button for creating new comments or replies.
 * Shows a loading indicator while submission is in progress and clears the
 * textarea on success.
 */
export function DocumentCommentForm({
  onSubmit,
  placeholder = "Add a comment…",
  autoFocus = false,
}: DocumentCommentFormProps) {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmed = content.trim();
      if (!trimmed || submitting) return;

      setSubmitting(true);
      try {
        await onSubmit(trimmed);
        setContent("");
        textareaRef.current?.focus();
      } finally {
        setSubmitting(false);
      }
    },
    [content, submitting, onSubmit],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void handleSubmit(event);
      }
    },
    [handleSubmit],
  );

  const canSubmit = content.trim().length > 0 && !submitting;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={submitting}
        rows={2}
        className="block w-full resize-none rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] px-3 py-2 text-body-medium-lighter text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-[border-color] duration-150 ease-out focus-visible:border-[var(--border-active)] disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          size="compact"
          leftIcon={<Send />}
          disabled={!canSubmit}
        >
          {submitting ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
