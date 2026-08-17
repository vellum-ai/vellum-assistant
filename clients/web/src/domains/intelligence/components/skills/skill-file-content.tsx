import { FileMarkdown, isMarkdown } from "@/components/file-markdown";
import { useTranslation } from "@/i18n";

/**
 * Standalone file-content viewer used by the mobile skill-detail view.
 *
 * Mirrors the private `FileContent` in `skill-detail.tsx` (desktop) but adds a
 * `viewMode` prop so callers can toggle between the rendered markdown
 * ("preview") and its raw source ("raw"). Non-markdown files always render as
 * source regardless of `viewMode`.
 */
export function SkillFileContent({
  fileName,
  content,
  isBinary,
  viewMode = "preview",
}: {
  fileName: string;
  content: string | null;
  isBinary: boolean;
  viewMode?: "preview" | "raw";
}) {
  const { t } = useTranslation("intelligence");
  if (isBinary) {
    return (
      <p
        className="flex h-full items-center justify-center text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        {t("skillFileContent.binaryFile")}
      </p>
    );
  }

  if (content === null) {
    return (
      <p
        className="flex h-full items-center justify-center text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        {t("skillFileContent.noPreviewAvailable", { fileName })}
      </p>
    );
  }

  if (isMarkdown(fileName, undefined) && viewMode === "preview") {
    return (
      <div
        className="h-full overflow-auto px-6 py-4"
        style={{ color: "var(--content-default)" }}
      >
        <FileMarkdown content={content} />
      </div>
    );
  }

  return (
    <pre
      className="h-full overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-body-small-default"
      style={{ color: "var(--content-default)" }}
    >
      {content}
    </pre>
  );
}
