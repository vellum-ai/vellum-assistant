/**
 * Read-only view of an OOXML workbook (`.xlsx`, `.xlsm`) opened in the
 * document drawer.
 *
 * This file owns the container: `XlsxPreview` reads the blob's workbook
 * metadata, `WorkbookGrid` shows one sheet at a time through the shared
 * `TabularGrid`. A sheet's own part is read when its tab is opened, so a
 * workbook costs the sheet on screen rather than all of them, and a sheet that
 * cannot be read fails inside its own panel while the other tabs stay usable.
 */

import { useEffect, useState, type ReactNode } from "react";

import { ScrollShadow, Tabs, Typography } from "@vellumai/design-library";

import type { ParsedCsv } from "@/domains/chat/components/local-file/preview/csv";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { TabularGrid } from "@/domains/chat/components/local-file/preview/tabular-grid";
import {
  parseWorkbook,
  type WorkbookSheet,
} from "@/domains/chat/components/local-file/preview/xlsx";
import { useTranslation } from "@/i18n";

interface XlsxPreviewProps {
  blob: Blob;
  filename: string;
}

/**
 * Reads `source`, dropping a reply that lands after the source changed or the
 * component unmounted. `read` is a dependency, so it has to be stable: an
 * inline arrow would restart the read on every render.
 */
function useAsyncRead<S, T>(
  source: S,
  read: (source: S) => Promise<T>,
): { value: T | null; failed: boolean } {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setValue(null);
    setFailed(false);
    read(source).then(
      (result) => {
        if (!cancelled) {
          setValue(result);
        }
      },
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, read]);

  return { value, failed };
}

const readSheet = (sheet: WorkbookSheet): Promise<ParsedCsv> => sheet.read();

/** The sheet on screen, which is the only one whose part is ever read. */
function SheetPanel({ sheet }: { sheet: WorkbookSheet }): ReactNode {
  const { t } = useTranslation("chat");
  const { value: grid, failed: readFailed } = useAsyncRead(sheet, readSheet);

  if (readFailed) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center p-4"
      >
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {t("xlsxPreview.sheetUnreadable")}
        </Typography>
      </div>
    );
  }
  if (grid === null) {
    return <PreviewSkeleton />;
  }

  const columns = grid.headers?.length ?? grid.rows[0]?.length ?? 0;
  return (
    <TabularGrid
      {...grid}
      emptyLabel={t("xlsxPreview.emptySheet")}
      summary={t(
        grid.truncated ? "xlsxPreview.summaryTruncated" : "xlsxPreview.summary",
        { sheet: sheet.name, rows: grid.rows.length, columns },
      )}
    />
  );
}

/**
 * The sheets of an already-parsed workbook, with a switcher once there is
 * more than one. Exported so stories and tests can state sheets directly
 * instead of building a container.
 */
export function WorkbookGrid({
  sheets,
}: {
  sheets: WorkbookSheet[];
}): ReactNode {
  const { t } = useTranslation("chat");
  const [activeName, setActiveName] = useState(() => sheets[0]?.name ?? "");

  // Sheet names are unique within a workbook, so the name is the selection.
  // A name the current workbook no longer has falls back to its first sheet.
  const active = sheets.find((sheet) => sheet.name === activeName) ?? sheets[0];
  // An empty list only arrives from a story or a test: the container turns a
  // parsed workbook with no sheets into the preview error state.
  if (active === undefined) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sheets.length === 1 ? (
        <SheetPanel sheet={active} />
      ) : (
        <Tabs.Root
          value={active.name}
          onValueChange={setActiveName}
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
              {sheets.map((sheet) => (
                <Tabs.Trigger
                  key={sheet.name}
                  value={sheet.name}
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
          {/* Only the open sheet is mounted, so no other sheet is ever read. */}
          <Tabs.Panel
            key={active.name}
            value={active.name}
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
