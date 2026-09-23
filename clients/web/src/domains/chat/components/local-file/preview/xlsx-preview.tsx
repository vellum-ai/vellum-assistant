/**
 * Read-only view of an OOXML workbook (`.xlsx`, `.xlsm`) opened in the
 * document drawer.
 *
 * This file owns the container: `XlsxPreview` reads the blob's workbook
 * metadata, `WorkbookGrid` shows one sheet at a time through the shared
 * `TabularGrid`. A sheet's own part is read when its tab is opened, so a
 * workbook costs the sheet on screen rather than all of them, and a sheet that
 * cannot be read fails inside its own panel while the other tabs stay usable.
 * The switcher itself is bounded, so a workbook's sheet count cannot cost the
 * browser a trigger apiece.
 */

import { useState, type ReactNode } from "react";

import { ScrollShadow, Tabs, Typography } from "@vellumai/design-library";

import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewNotice } from "@/domains/chat/components/local-file/preview/preview-notice";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import {
  columnCountOf,
  TabularGrid,
} from "@/domains/chat/components/local-file/preview/tabular-grid";
import { useAsyncRead } from "@/domains/chat/components/local-file/preview/use-async-read";
import {
  parseWorkbook,
  type WorkbookSheet,
} from "@/domains/chat/components/local-file/preview/xlsx";
import { useTranslation } from "@/i18n";

/**
 * Sheet tabs the switcher mounts. Workbook metadata is compact enough that a
 * generated file can declare thousands of sheets inside the part limits, and a
 * trigger apiece stalls the browser before a single sheet is read, so the rest
 * are counted in a line under the tab strip instead.
 */
export const MAX_SHEET_TABS = 100;

interface XlsxPreviewProps {
  blob: Blob;
  filename: string;
}

/** The sheet on screen, which is the only one whose part is ever read. */
function SheetPanel({ sheet }: { sheet: WorkbookSheet }): ReactNode {
  const { t } = useTranslation("chat");
  const { value: grid, failed: readFailed } = useAsyncRead(sheet, (source) =>
    source.read(),
  );

  if (readFailed) {
    return <PreviewNotice>{t("xlsxPreview.sheetUnreadable")}</PreviewNotice>;
  }
  if (grid === null) {
    return <PreviewSkeleton />;
  }

  const columns = columnCountOf(grid);
  // A sheet whose populated cells all sit past the row or column cap reads as
  // a grid with nothing in it, so it names the cap rather than claiming the
  // sheet holds no data.
  if (columns === 0 && grid.truncated) {
    return <PreviewNotice>{t("xlsxPreview.beyondPreviewLimit")}</PreviewNotice>;
  }

  // A sheet with no columns shows the empty copy in place of a footer, so its
  // sentence is never built.
  const summary =
    columns === 0
      ? undefined
      : t(
          grid.truncated
            ? "xlsxPreview.summaryTruncated"
            : "xlsxPreview.summary",
          { sheet: sheet.name, rows: grid.rows.length, columns },
        );

  return (
    <TabularGrid
      {...grid}
      emptyLabel={t("xlsxPreview.emptySheet")}
      summary={summary}
    />
  );
}

/**
 * The sheets of an already-parsed workbook, with a switcher over the first
 * `MAX_SHEET_TABS` of them and a line naming the ones left out. Exported so
 * stories and tests can state sheets directly instead of building a
 * container.
 */
export function WorkbookGrid({
  sheets,
}: {
  sheets: WorkbookSheet[];
}): ReactNode {
  const { t } = useTranslation("chat");
  const [activeIndex, setActiveIndex] = useState(0);

  const shown = sheets.slice(0, MAX_SHEET_TABS);
  const omitted = sheets.length - shown.length;

  // Position, not name, is the selection: a name can repeat, be empty, or
  // carry spaces, and the tab value becomes the `id` the panel is wired to.
  // A workbook that loses sheets keeps the last one selected.
  const selectedIndex = Math.min(activeIndex, shown.length - 1);
  const active = shown[selectedIndex];
  // Type narrowing for the lookup above.
  if (active === undefined) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {shown.length === 1 ? (
        <SheetPanel sheet={active} />
      ) : (
        <Tabs.Root
          value={String(selectedIndex)}
          onValueChange={(value) => setActiveIndex(Number(value))}
          // Arrowing across a 24-sheet workbook must not read 24 sheets.
          activationMode="manual"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <ScrollShadow
            orientation="horizontal"
            hideScrollBar
            // The rule sits on the scroller, which is full width, rather than
            // on the list, which is only as wide as the tabs it holds.
            className="shrink-0 border-b border-[var(--border-base)]"
          >
            <Tabs.List
              aria-label={t("xlsxPreview.sheetsAria")}
              className="border-b-0 px-4"
            >
              {shown.map((sheet, index) => (
                <Tabs.Trigger
                  key={index}
                  value={String(index)}
                  title={sheet.name}
                  className="shrink-0"
                >
                  <span className="block max-w-[12rem] truncate">
                    {sheet.name}
                  </span>
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </ScrollShadow>
          {omitted > 0 ? (
            <Typography
              as="p"
              variant="label-small-default"
              className="shrink-0 px-4 py-1.5 text-[var(--content-tertiary)]"
            >
              {t("xlsxPreview.sheetsOmitted", { count: omitted })}
            </Typography>
          ) : null}
          {/* Only the open sheet is mounted, so no other sheet is ever read. */}
          <Tabs.Panel
            key={selectedIndex}
            value={String(selectedIndex)}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <SheetPanel sheet={active} />
          </Tabs.Panel>
        </Tabs.Root>
      )}
    </div>
  );
}

export function XlsxPreview({ blob, filename }: XlsxPreviewProps): ReactNode {
  // Only the container's metadata parts: each sheet's grid waits for its tab.
  const { value: workbook, failed: parseFailed } = useAsyncRead(
    blob,
    parseWorkbook,
  );

  // A workbook that parses but declares no sheets has nothing to show, so it
  // lands on the failure state rather than a blank drawer body.
  if (parseFailed || workbook?.sheets.length === 0) {
    return <PreviewError filename={filename} />;
  }
  if (workbook === null) {
    return <PreviewSkeleton />;
  }

  return <WorkbookGrid sheets={workbook.sheets} />;
}
