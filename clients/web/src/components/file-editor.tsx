/**
 * Shared file-editing UI primitives used by both the workspace browser and
 * the skills tab. These are purely presentational — data fetching and mutation
 * logic stays with each consumer.
 */

import { Check, Copy, Download, Pencil } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@vellumai/design-library/components/button";

import { useTranslation } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { saveFile } from "@/runtime/native-file";

export const MONO_FONT =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

export function ContentActionBar({
  content,
  downloadContent,
  fileName,
  mimeType = "text/plain",
  showEdit,
  isEditing,
  onToggleEdit,
  extraActions,
}: {
  content: string;
  downloadContent?: string;
  fileName: string;
  mimeType?: string;
  showEdit?: boolean;
  isEditing: boolean;
  onToggleEdit?: () => void;
  extraActions?: ReactNode;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    copyToClipboard(content, {
      errorMessage: t("contentActionBar.copyFailed"),
      onCopied: () => {
        setCopied(true);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      },
    });
  }, [content, t]);

  const rawContent = downloadContent ?? content;
  const handleDownload = useCallback(() => {
    void saveFile(new Blob([rawContent], { type: mimeType }), fileName);
  }, [rawContent, fileName, mimeType]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  if (isEditing) {
    return null;
  }

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md bg-[var(--surface-primary)] shadow-sm">
      {showEdit && onToggleEdit && (
        <Button
          variant="ghost"
          size="regular"
          iconOnly={<Pencil aria-hidden />}
          onClick={onToggleEdit}
          aria-label={t("contentActionBar.editFileAria")}
          className="hover:bg-[var(--surface-base)]"
        />
      )}
      {extraActions}
      <Button
        variant="ghost"
        size="regular"
        iconOnly={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        onClick={handleCopy}
        aria-label={
          copied
            ? t("contentActionBar.copiedAria")
            : t("contentActionBar.copyFileContentsAria")
        }
        className="hover:bg-[var(--surface-base)]"
      />
      <Button
        variant="ghost"
        size="regular"
        iconOnly={<Download aria-hidden />}
        onClick={handleDownload}
        aria-label={t("contentActionBar.downloadFileAria")}
        className="hover:bg-[var(--surface-base)]"
      />
    </div>
  );
}

export function FileTextarea({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <textarea
      className="m-0 h-full w-full resize-none overflow-auto border-none bg-transparent p-4 text-body-medium-lighter leading-relaxed outline-none"
      style={{ color: "var(--content-default)", fontFamily: MONO_FONT }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          onSave();
        }
      }}
      spellCheck={false}
    />
  );
}

export function EditFooter({
  isDirty,
  isSaving,
  error,
  onSave,
  onDiscard,
}: {
  isDirty: boolean;
  isSaving: boolean;
  error?: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center justify-end gap-2 border-t px-3 py-2"
      style={{ borderColor: "var(--border-element)" }}
    >
      {error && (
        <span
          className="mr-auto text-body-small-default"
          style={{ color: "var(--system-error)" }}
        >
          {error}
        </span>
      )}
      <Button
        variant="ghost"
        size="compact"
        disabled={isSaving}
        onClick={onDiscard}
      >
        {t("editFooter.discard")}
      </Button>
      <Button
        variant="primary"
        size="compact"
        disabled={!isDirty || isSaving}
        onClick={onSave}
      >
        {isSaving ? t("editFooter.saving") : t("editFooter.save")}
      </Button>
    </div>
  );
}

export function SourcePre({
  content,
  readOnly,
  whiteSpace = "pre-wrap",
  onStartEdit,
}: {
  content: string;
  readOnly: boolean;
  whiteSpace?: "pre" | "pre-wrap";
  onStartEdit?: () => void;
}) {
  return (
    <pre
      className={`m-0 h-full overflow-auto p-4 text-body-medium-lighter leading-relaxed${!readOnly ? " cursor-text" : ""}`}
      style={{
        color: "var(--content-default)",
        fontFamily: MONO_FONT,
        whiteSpace,
      }}
      onClick={!readOnly ? onStartEdit : undefined}
    >
      {content}
    </pre>
  );
}
