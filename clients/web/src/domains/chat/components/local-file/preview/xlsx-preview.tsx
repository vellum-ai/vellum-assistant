/**
 * Read-only view of an OOXML workbook (`.xlsx`, `.xlsm`) opened in the
 * document drawer.
 *
 * This file owns the container: `XlsxPreview` reads the blob's workbook
 * metadata, `WorkbookGrid` shows one sheet at a time through the shared
 * `TabularGrid`. A sheet's own part is read when its tab is opened, so a
 * workbook costs the sheet on screen rather than all of them, and a sheet that
 * cannot be read fails inside its own panel while the other tabs stay usable.
 * The reader hands over the sheets the switcher shows and how many there are,
 * so a workbook's sheet count cannot cost the browser a trigger apiece.
 *
 * A workbook of several sheets carries the sentence describing the open one in
 * the bar beside its tabs, so the grid above draws no footer of its own.
 */

import { useId, useState, type ReactNode } from "react";

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
  type SheetGrid,
  type WorkbookSheet,
} from "@/domains/chat/components/local-file/preview/xlsx";
import { useTranslation } from "@/i18n";

interface XlsxPreviewProps {
  blob: Blob;
  filename: string;
}

/** What a workbook with no sheet to open reads to. */
const NO_GRID: SheetGrid = {
  headers: null,
  rows: [],
  truncated: false,
  extent: null,
};

/**
 * The grid a sheet reads to. An absent sheet resolves to an empty one so the
 * read runs unconditionally, ahead of the lookup it depends on.
 */
function readSheetGrid(sheet: WorkbookSheet | undefined): Promise<SheetGrid> {
  return sheet === undefined ? Promise.resolve(NO_GRID) : sheet.read();
}

/** Which sentence a sheet's counts read as. */
type SummaryShape =
  | "plain"
  | "truncated"
  | "columnsCut"
  | "rowsCut"
  | "bothCut";

/** The sentence naming the sheet, one key per shape. */
const SHEET_SUMMARY_KEYS = {
  plain: "xlsxPreview.summary",
  truncated: "xlsxPreview.summaryTruncated",
  columnsCut: "xlsxPreview.summaryColumnsCut",
  rowsCut: "xlsxPreview.summaryRowsCut",
  bothCut: "xlsxPreview.summaryBothCut",
} as const;

/** The same sentences for the bar, where the tab beside it does the naming. */
const BAR_SUMMARY_KEYS = {
  plain: "csvPreview.summary",
  truncated: "csvPreview.summaryTruncated",
  columnsCut: "xlsxPreview.countsColumnsCut",
  rowsCut: "xlsxPreview.countsRowsCut",
  bothCut: "xlsxPreview.countsBothCut",
} as const;

/**
 * The shape a sheet's sentence takes and the counts it names. A cut sheet
 * names what it left out by measuring what the grid shows against the range
 * the file states, so a sheet stating none keeps the sentence that can only
 * say it was cut. A detected header row is a sheet row too, so it counts
 * toward what is shown.
 */
function summarize(grid: SheetGrid): {
  shape: SummaryShape;
  values: Record<string, number>;
} {
  const columns = columnCountOf(grid);
  const shown = { rows: grid.rows.length, columns };
  const extent = grid.extent;
  if (!grid.truncated || extent === null) {
    return { shape: grid.truncated ? "truncated" : "plain", values: shown };
  }
  const rows = grid.rows.length + (grid.headers === null ? 0 : 1);
  const rowsCut = extent.rows > rows;
  const columnsCut = extent.columns > columns;
  if (rowsCut && columnsCut) {
    return {
      shape: "bothCut",
      values: {
        rows,
        columns,
        totalRows: extent.rows,
        totalColumns: extent.columns,
      },
    };
  }
  if (rowsCut) {
    return { shape: "rowsCut", values: { rows, columns, total: extent.rows } };
  }
  if (columnsCut) {
    return {
      shape: "columnsCut",
      values: { rows, columns, total: extent.columns },
    };
  }
  return { shape: "truncated", values: shown };
}

/**
 * The sheet on screen: its grid, or the notice standing in for one that cannot
 * be read, is still being read, or holds nothing this preview can draw.
 */
function SheetPanel({
  grid,
  readFailed,
  summary,
}: {
  grid: SheetGrid | null;
  readFailed: boolean;
  summary: string | null;
}): ReactNode {
  const { t } = useTranslation("chat");

  if (readFailed) {
    return <PreviewNotice>{t("xlsxPreview.sheetUnreadable")}</PreviewNotice>;
  }
  if (grid === null) {
    return <PreviewSkeleton />;
  }

  // A sheet whose populated cells all sit past the row or column cap reads as
  // a grid with nothing in it, so it names the cap rather than claiming the
  // sheet holds no data.
  if (columnCountOf(grid) === 0 && grid.truncated) {
    return <PreviewNotice>{t("xlsxPreview.beyondPreviewLimit")}</PreviewNotice>;
  }

  // The extent says what a cut left out, which the sentence already carries.
  const { extent: _extent, ...tabular } = grid;
  return (
    <TabularGrid
      {...tabular}
      emptyLabel={t("xlsxPreview.emptySheet")}
      summary={summary}
    />
  );
}

/**
 * The sheets of an already-parsed workbook, with a switcher over the ones the
 * reader built and a line counting the rest. `sheetCount` is how many sheets
 * the workbook shows, which a fixture stating its own sheets leaves out.
 * Exported so stories and tests can state sheets directly instead of building
 * a container.
 */
export function WorkbookGrid({
  sheets,
  sheetCount = sheets.length,
}: {
  sheets: WorkbookSheet[];
  sheetCount?: number;
}): ReactNode {
  const { t } = useTranslation("chat");
  const [activeIndex, setActiveIndex] = useState(0);
  const summaryId = useId();

  const omitted = sheetCount - sheets.length;

  // Position, not name, is the selection: a name can repeat, be empty, or
  // carry spaces, and the tab value becomes the `id` the panel is wired to.
  // A workbook that loses sheets keeps the last one selected.
  const selectedIndex = Math.min(activeIndex, sheets.length - 1);
  const active = sheets[selectedIndex];
  const { value: grid, failed: readFailed } = useAsyncRead(
    active,
    readSheetGrid,
  );

  // Type narrowing for the lookup above.
  if (active === undefined) {
    return null;
  }

  // A sheet still being read, or holding nothing the grid can draw, shows the
  // skeleton or the empty notice in place of a sentence.
  const counts =
    grid === null || columnCountOf(grid) === 0 ? null : summarize(grid);
  const sheetSummary =
    counts === null
      ? null
      : t(SHEET_SUMMARY_KEYS[counts.shape], {
          sheet: active.name,
          ...counts.values,
        });
  // The bar's sentence counts without naming, because the tab beside it
  // already names the sheet.
  const barSummary =
    counts === null ? null : t(BAR_SUMMARY_KEYS[counts.shape], counts.values);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sheets.length === 1 ? (
        <SheetPanel
          grid={grid}
          readFailed={readFailed}
          summary={sheetSummary}
        />
      ) : (
        <Tabs.Root
          value={String(selectedIndex)}
          onValueChange={(value) => setActiveIndex(Number(value))}
          // Arrowing across a 24-sheet workbook must not read 24 sheets.
          activationMode="manual"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {/*
            Only the open sheet is mounted, so no other sheet is ever read, and
            the key starts each sheet at its first row.
          */}
          <Tabs.Panel
            key={selectedIndex}
            value={String(selectedIndex)}
            aria-describedby={barSummary === null ? undefined : summaryId}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <SheetPanel grid={grid} readFailed={readFailed} summary={null} />
          </Tabs.Panel>
          {omitted > 0 ? (
            <Typography
              as="p"
              variant="label-small-default"
              className="shrink-0 px-4 py-1.5 text-[var(--content-tertiary)]"
            >
              {t("xlsxPreview.sheetsOmitted", { count: omitted })}
            </Typography>
          ) : null}
          {/*
            The sheet row and the sentence about the open sheet share one bar
            under the grid. The rule sits on the bar, which is full width,
            rather than on the list, which is only as wide as the tabs it holds.
          */}
          <div className="flex shrink-0 items-center border-t border-[var(--border-base)]">
            <ScrollShadow
              orientation="horizontal"
              hideScrollBar
              className="min-w-0 flex-1"
            >
              <Tabs.List
                aria-label={t("xlsxPreview.sheetsAria")}
                placement="bottom"
                className="border-t-0 px-4"
              >
                {sheets.map((sheet, index) => (
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
            {barSummary === null ? null : (
              <Typography
                as="p"
                variant="label-small-default"
                id={summaryId}
                // Half the bar at most, so the sentence cannot crowd the tabs
                // off a phone.
                className="max-w-[50%] shrink-0 truncate py-1.5 pr-4 pl-3 text-[var(--content-tertiary)]"
                title={barSummary}
              >
                {barSummary}
              </Typography>
            )}
          </div>
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

  return (
    <WorkbookGrid sheets={workbook.sheets} sheetCount={workbook.sheetCount} />
  );
}
