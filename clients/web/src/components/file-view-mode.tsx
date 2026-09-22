/**
 * Formatted or source: the one choice every file surface offers, in the same
 * words and the same control wherever it appears.
 *
 * Before this existed the same idea was built three times, with two different
 * controls and three names for the two modes (preview/raw, preview/source),
 * and most file content offered neither. "Formatted" and "Source" are the
 * names now; a chat message is not a file and does not get the choice.
 *
 * The control is the design library's `SegmentControl`. It lives apart from
 * `MarkdownView` because a surface may own the mode itself: the workspace
 * viewer edits in source, so the mode drives its action bar as well as its
 * content, and it applies to a JSON file's pretty-printed view just as much
 * as to markdown.
 */

import { Code, Eye } from "lucide-react";

import { SegmentControl } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export type FileViewMode = "formatted" | "source";

export function FileViewModeControl({
  mode,
  onChange,
}: {
  mode: FileViewMode;
  onChange: (mode: FileViewMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <SegmentControl<FileViewMode>
      iconOnly
      ariaLabel={t("fileViewMode.modeAria")}
      value={mode}
      onChange={onChange}
      items={[
        {
          value: "formatted",
          label: t("fileViewMode.formatted"),
          icon: <Eye aria-hidden />,
        },
        {
          value: "source",
          label: t("fileViewMode.source"),
          icon: <Code aria-hidden />,
        },
      ]}
    />
  );
}
