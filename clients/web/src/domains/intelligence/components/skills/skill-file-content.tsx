import { isMarkdown } from "@/components/file-markdown";
import { MarkdownView } from "@/components/markdown-view";
import { useTranslation } from "@/i18n";

/**
 * Standalone file-content viewer used by the mobile skill-detail view.
 *
 * A markdown file shows formatted with its source one click away, through the
 * shared `MarkdownView`, so it offers the same choice in the same words as
 * every other file surface. Anything else is source, which is all it has.
 *
 * The caller keys this by the file's path, so opening another file starts
 * formatted rather than inheriting what the last one was left showing. A
 * basename cannot carry that: a skill can hold `docs/README.md` and
 * `examples/README.md`.
 */
export function SkillFileContent({
  fileName,
  content,
  isBinary,
}: {
  fileName: string;
  content: string | null;
  isBinary: boolean;
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

  if (isMarkdown(fileName, undefined)) {
    return <MarkdownView content={content} className="px-6 py-4" />;
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
